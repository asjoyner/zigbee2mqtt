import bind from "bind-decorator";
import stringify from "json-stable-stringify-without-jsonify";
import Device from "../model/device";
import Group from "../model/group";
import type {Zigbee2MQTTGroupOptions} from "../types/api";
import logger from "../util/logger";
import * as settings from "../util/settings";
import utils from "../util/utils";
import Extension from "./extension";

// Per-group smartBulbMode reconciliation for Inovelli VZM31-SN switches.
//
// Pairs with GroupBindEnforcement: this extension does NOT manage the
// paddle-scene → bulb-group bindings (those live in the device's `binds`
// config and are enforced by GroupBindEnforcement). It only manages the
// switch-side state needed for the group's bulbs to be reachable:
//   - smartBulbMode attribute on the controlling switch
//   - relay state (the switch's onOff state) when smart_bulb_mode is on,
//     so the bulbs stay energized
//
// Configuration lives on the group:
//
//   groups:
//     '1':
//       friendly_name: zg_kitchen_walkways
//       controlling_switch: 'Kitchen Walkways in Stairwell'
//       smart_bulb_mode: true

// Manufacturer cluster name + attribute. Matches the Inovelli definition
// in zigbee-herdsman-converters/lib/inovelli.ts; registered as a custom
// cluster on Inovelli devices at init.
const INOVELLI_CLUSTER_NAME = "manuSpecificInovelli";
const INOVELLI_MANUFACTURER_CODE = 0x122f;
const SMART_BULB_MODE_ATTR = "smartBulbMode";
// 0=Disabled, 1=Smart Bulb Mode (per the device's BOOLEAN encoding).
const SMART_BULB_MODE_ON = 1;
const SMART_BULB_MODE_OFF = 0;

type SmartBulbModeStatus = "on" | "off" | "unknown";

interface PerGroupStats {
    group: string;
    controlling_switch?: string | number;
    desired: SmartBulbModeStatus;
    actual: SmartBulbModeStatus;
    last_reconciled?: string;
    last_error?: string;
}

export default class SmartBulbMode extends Extension {
    private pollTimer?: ReturnType<typeof setTimeout>;
    private groupStats = new Map<number, PerGroupStats>();

    // Tied to group_bind_cooldown so operators don't need a second knob;
    // the two reconcilers conceptually run together. If a future use case
    // wants them on different cadences, split into a dedicated setting.
    private getPollIntervalMinutes(): number {
        const cd = settings.get().advanced.group_bind_cooldown;
        return cd !== undefined && cd > 0 ? cd : 0;
    }

    private isEnabled(): boolean {
        // Run if SOMETHING wants enforcement and at least one group
        // configures smart_bulb_mode. The "at least one" check is a soft
        // guard so totally-unconfigured deploys don't run an empty poll.
        if (this.getPollIntervalMinutes() === 0) {
            const persisted = settings.getPersistedSettings().advanced;
            if (persisted?.group_bind_unexpected === undefined && persisted?.group_bind_missing === undefined) {
                return false;
            }
        }
        const groups = settings.get().groups ?? {};
        return Object.values(groups).some(
            (g) => (g as Zigbee2MQTTGroupOptions).controlling_switch !== undefined,
        );
    }

    override async start(): Promise<void> {
        if (!this.isEnabled()) return;

        const interval = this.getPollIntervalMinutes() || 10;
        logger.info(`Smart Bulb Mode: starting reconciler (interval: ${interval} min)`);

        // Listen for group option changes so toggling smart_bulb_mode (via
        // bridge/request/group/options or a configuration.yaml edit) takes
        // effect immediately rather than waiting for the next poll.
        this.eventBus.onEntityOptionsChanged(this, this.onEntityOptionsChanged);

        await this.publishAllGroupStatus();
        // Jittered initial fire to avoid stampeding the network at boot.
        this.pollTimer = setTimeout(() => this.schedulePoll(interval), utils.minutes(1) + Math.random() * utils.minutes(1));
    }

    @bind private async onEntityOptionsChanged(data: eventdata.EntityOptionsChanged): Promise<void> {
        // Only react to group option changes that touch the fields we own.
        if (!(data.entity instanceof Group)) return;
        const before = data.from ?? {};
        const after = data.to ?? {};
        const changed =
            before.controlling_switch !== after.controlling_switch ||
            before.smart_bulb_mode !== after.smart_bulb_mode;
        if (!changed) return;

        const groupOpts = settings.getGroup(data.entity.ID) as unknown as Zigbee2MQTTGroupOptions | undefined;
        if (!groupOpts) return;

        if (groupOpts.controlling_switch === undefined) {
            // Group was un-configured. Clear our cached stats and the
            // retained status topic so observers don't see stale data.
            this.groupStats.delete(data.entity.ID);
            await this.mqtt.publish(`${data.entity.name}/smart_bulb_mode`, "", {clientOptions: {retain: true}, skipLog: true});
            return;
        }

        await this.reconcileGroup(data.entity, groupOpts);
        const stats = this.groupStats.get(data.entity.ID);
        if (stats) await this.publishGroupStatus(stats);
    }

    override async stop(): Promise<void> {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        await super.stop();
    }

    private async schedulePoll(intervalMinutes: number): Promise<void> {
        await this.reconcileAll();
        if (!this.zigbee.isStopping()) {
            this.pollTimer = setTimeout(() => this.schedulePoll(intervalMinutes), utils.minutes(intervalMinutes));
        }
    }

    // Reconcile every group that has controlling_switch configured.
    // smart_bulb_mode defaults to false (i.e., explicit "Disabled" target)
    // if the field is omitted alongside a controlling_switch — keeps
    // behavior predictable when an operator sets only the link without
    // the toggle.
    private async reconcileAll(): Promise<void> {
        if (this.zigbee.isStopping()) return;

        const allGroups = settings.get().groups ?? {};
        for (const [idStr, opts] of Object.entries(allGroups)) {
            const groupId = Number(idStr);
            if (Number.isNaN(groupId)) continue;
            const groupOpts = opts as Zigbee2MQTTGroupOptions;
            if (groupOpts.controlling_switch === undefined) {
                // Group doesn't opt into smart-bulb management; nothing to do.
                this.groupStats.delete(groupId);
                continue;
            }

            const group = this.zigbee.groupByID(groupId);
            if (!group) continue;

            await this.reconcileGroup(group, groupOpts);
        }

        await this.publishAllGroupStatus();
    }

    @bind public async reconcileGroup(group: Group, groupOpts: Zigbee2MQTTGroupOptions): Promise<void> {
        const desired = groupOpts.smart_bulb_mode === true ? "on" : "off";
        const stats: PerGroupStats = {
            group: group.name,
            controlling_switch: groupOpts.controlling_switch,
            desired,
            actual: "unknown",
        };
        this.groupStats.set(group.ID, stats);

        try {
            const switchKey = groupOpts.controlling_switch!.toString();
            const entity = this.zigbee.resolveEntity(switchKey);
            if (!(entity instanceof Device)) {
                stats.last_error = `controlling_switch '${switchKey}' is not a known device`;
                logger.warning(`Smart Bulb Mode [${group.name}]: ${stats.last_error}`);
                return;
            }
            const device = entity;

            // Find the endpoint that supports the Inovelli manuSpecific
            // cluster. VZM31-SN exposes it on endpoint 1 today; we look
            // it up dynamically so VZM35/VZM36 (fan/dimmer variants) work
            // without a per-model branch.
            const endpoint = device.zh.endpoints.find((ep) => ep.supportsInputCluster(INOVELLI_CLUSTER_NAME));
            if (!endpoint) {
                stats.last_error = `device '${device.name}' does not expose '${INOVELLI_CLUSTER_NAME}' cluster on any endpoint`;
                logger.warning(`Smart Bulb Mode [${group.name}]: ${stats.last_error}`);
                return;
            }

            // Read current attribute. Use the cache when available (recent
            // read); fall back to a live read. The Inovelli cluster is
            // registered at runtime via deviceAddCustomCluster, so its
            // attribute names aren't known to the generic type — cast the
            // attribute-key array and the result through `unknown`.
            let currentValue: number | undefined;
            try {
                const cached = endpoint.getClusterAttributeValue(INOVELLI_CLUSTER_NAME, SMART_BULB_MODE_ATTR);
                if (typeof cached === "number") {
                    currentValue = cached;
                } else {
                    const read = (await endpoint.read(
                        INOVELLI_CLUSTER_NAME,
                        [SMART_BULB_MODE_ATTR] as unknown as Parameters<typeof endpoint.read>[1],
                    )) as Record<string, unknown>;
                    const v = read[SMART_BULB_MODE_ATTR];
                    if (typeof v === "number") currentValue = v;
                }
            } catch (err) {
                stats.last_error = `read failed: ${(err as Error).message}`;
                logger.debug(`Smart Bulb Mode [${group.name}]: ${stats.last_error}`);
                return;
            }

            stats.actual = currentValue === SMART_BULB_MODE_ON ? "on" : currentValue === SMART_BULB_MODE_OFF ? "off" : "unknown";

            const desiredValue = desired === "on" ? SMART_BULB_MODE_ON : SMART_BULB_MODE_OFF;

            if (currentValue !== desiredValue) {
                logger.info(`Smart Bulb Mode [${group.name}]: writing smartBulbMode=${desired} on '${device.name}'`);
                try {
                    // manuSpecificInovelli is a runtime-registered custom
                    // cluster (added via deviceAddCustomCluster in
                    // herdsman-converters/lib/inovelli), so its attribute
                    // schema isn't known to the TS generic at write() — the
                    // cast keeps the literal `smartBulbMode` key while
                    // satisfying the compiler. Matches the pattern used in
                    // the Inovelli converter (tzLocal in lib/inovelli.js).
                    await endpoint.write(
                        INOVELLI_CLUSTER_NAME,
                        {smartBulbMode: desiredValue} as unknown as Parameters<typeof endpoint.write>[1],
                        {manufacturerCode: INOVELLI_MANUFACTURER_CODE},
                    );
                    stats.actual = desired;
                } catch (err) {
                    stats.last_error = `write failed: ${(err as Error).message}`;
                    logger.error(`Smart Bulb Mode [${group.name}]: ${stats.last_error}`);
                    return;
                }
            }

            // When smart_bulb_mode is on, hold the relay closed so the bulbs
            // stay energized. Idempotent: only fire if the switch's onOff
            // state is currently off.
            if (desired === "on") {
                try {
                    const onOff = endpoint.getClusterAttributeValue("genOnOff", "onOff");
                    if (onOff !== 1) {
                        logger.info(`Smart Bulb Mode [${group.name}]: forcing relay on for '${device.name}'`);
                        await endpoint.command("genOnOff", "on", {});
                    }
                } catch (err) {
                    // Relay enforcement is best-effort — log but don't fail
                    // the reconcile. smartBulbMode being set is the
                    // load-bearing change; the relay forced-on is a
                    // nice-to-have to recover from a manual flip-down.
                    logger.debug(`Smart Bulb Mode [${group.name}]: relay-on check failed: ${(err as Error).message}`);
                }
            }

            stats.last_reconciled = new Date().toISOString();
            stats.last_error = undefined;
        } catch (err) {
            stats.last_error = (err as Error).message;
            logger.error(`Smart Bulb Mode [${group.name}]: ${stats.last_error}`);
        }
    }

    private async publishAllGroupStatus(): Promise<void> {
        for (const stats of this.groupStats.values()) {
            await this.publishGroupStatus(stats);
        }
    }

    private async publishGroupStatus(stats: PerGroupStats): Promise<void> {
        // <base_topic>/<group_friendly_name>/smart_bulb_mode
        const topic = `${stats.group}/smart_bulb_mode`;
        await this.mqtt.publish(topic, stringify(stats), {clientOptions: {retain: true}, skipLog: true});
    }
}
