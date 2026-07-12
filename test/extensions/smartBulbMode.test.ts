// biome-ignore assist/source/organizeImports: import mocks first
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import * as data from "../mocks/data";
import {mockLogger} from "../mocks/logger";
import {flushPromises} from "../mocks/utils";
import {devices, resetGroupMembers} from "../mocks/zigbeeHerdsman";

import {Controller} from "../../lib/controller";
import {parseSmartBulbModeState, SMART_BULB_MODE_OFF, SMART_BULB_MODE_ON} from "../../lib/extension/smartBulbMode";
import * as settings from "../../lib/util/settings";

describe("Extension: SmartBulbMode", () => {
    describe("parseSmartBulbModeState", () => {
        it("maps enum labels / numbers / booleans and rejects the rest", () => {
            expect(parseSmartBulbModeState("Smart Bulb Mode")).toBe(true);
            expect(parseSmartBulbModeState("Disabled")).toBe(false);
            expect(parseSmartBulbModeState(1)).toBe(true);
            expect(parseSmartBulbModeState(0)).toBe(false);
            expect(parseSmartBulbModeState(true)).toBe(true);
            expect(parseSmartBulbModeState(false)).toBe(false);
            expect(parseSmartBulbModeState("nonsense")).toBeUndefined();
            expect(parseSmartBulbModeState(2)).toBeUndefined();
            expect(parseSmartBulbModeState(undefined)).toBeUndefined();
        });
    });

    describe("adopting a user /set into config", () => {
        let controller: Controller;
        // Any configured, resolvable device works — the handler keys on the
        // MQTT `/set` topic + payload, not on the device's cluster.
        const switchName = "bulb_color";

        beforeAll(async () => {
            controller = new Controller(vi.fn(), vi.fn());
            await controller.start();
            await flushPromises();
        });

        afterAll(async () => {
            await controller?.stop();
        });

        beforeEach(() => {
            resetGroupMembers();
            data.writeDefaultConfiguration();
            settings.reRead();
            mockLogger.info.mockClear();
            // Make group_1 a smart-bulb-managed group driven by the controlling switch.
            settings.set(["groups", "1", "controlling_switch"], devices.bulb_color.ieeeAddr);
            settings.set(["groups", "1", "smart_bulb_mode"], false);
        });

        const getExt = () =>
            controller.getExtension("SmartBulbMode") as never as {
                rebuildControllingSwitchIndex: () => void;
                onMQTTMessage: (data: {topic: string; message: string}) => Promise<void>;
            };

        const set = async (topic: string, message: string) => {
            const ext = getExt();
            ext.rebuildControllingSwitchIndex();
            await ext.onMQTTMessage({topic, message});
            await flushPromises();
        };

        const sbm = (id: number) => (settings.getGroup(id) as unknown as {smart_bulb_mode?: boolean}).smart_bulb_mode;

        it("persists a whole-JSON /set of smartBulbMode", async () => {
            await set(`zigbee2mqtt/${switchName}/set`, JSON.stringify({smartBulbMode: "Smart Bulb Mode"}));
            expect(sbm(1)).toBe(true);
        });

        it("persists a per-attribute /set/smartBulbMode (turn off)", async () => {
            settings.set(["groups", "1", "smart_bulb_mode"], true);
            await set(`zigbee2mqtt/${switchName}/set/smartBulbMode`, "Disabled");
            expect(sbm(1)).toBe(false);
        });

        it("does not write config when already in sync", async () => {
            settings.set(["groups", "1", "smart_bulb_mode"], true);
            const spy = vi.spyOn(settings, "changeEntityOptions");
            await set(`zigbee2mqtt/${switchName}/set`, JSON.stringify({smartBulbMode: "Smart Bulb Mode"}));
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        });

        it("ignores a /set that doesn't touch smartBulbMode", async () => {
            const spy = vi.spyOn(settings, "changeEntityOptions");
            await set(`zigbee2mqtt/${switchName}/set`, JSON.stringify({state: "ON"}));
            expect(spy).not.toHaveBeenCalled();
            expect(sbm(1)).toBe(false);
            spy.mockRestore();
        });

        it("ignores a /set on a device that is not a controlling switch", async () => {
            await set("zigbee2mqtt/bulb/set", JSON.stringify({smartBulbMode: "Smart Bulb Mode"}));
            expect(sbm(1)).toBe(false);
        });

        it("ignores non-/set topics (e.g. /get) — device reports never adopt", async () => {
            const spy = vi.spyOn(settings, "changeEntityOptions");
            await set(`zigbee2mqtt/${switchName}/get`, JSON.stringify({smartBulbMode: ""}));
            await set(`zigbee2mqtt/${switchName}`, JSON.stringify({smartBulbMode: "Smart Bulb Mode"}));
            expect(spy).not.toHaveBeenCalled();
            expect(sbm(1)).toBe(false);
            spy.mockRestore();
        });

        it("ignores an unrecognized (corrupted) smartBulbMode value", async () => {
            const spy = vi.spyOn(settings, "changeEntityOptions");
            await set(`zigbee2mqtt/${switchName}/set/smartBulbMode`, "garbage");
            expect(spy).not.toHaveBeenCalled();
            expect(sbm(1)).toBe(false);
            spy.mockRestore();
        });
    });

    describe("reconcileGroup", () => {
        let controller: Controller;

        beforeAll(async () => {
            controller = new Controller(vi.fn(), vi.fn());
            await controller.start();
            await flushPromises();
        });

        afterAll(async () => {
            await controller?.stop();
        });

        beforeEach(() => {
            resetGroupMembers();
            data.writeDefaultConfiguration();
            settings.reRead();
            mockLogger.info.mockClear();
        });

        // The Inovelli manuSpecific cluster is registered at runtime via
        // deviceAddCustomCluster, so it isn't in the mock's cluster table.
        // Stub the endpoint surface the extension actually touches.
        const stubSwitch = (cachedMode: number | undefined) => {
            // biome-ignore lint/suspicious/noExplicitAny: reaching into controller internals for a focused unit test
            const zigbee = (controller as any).zigbee;
            const device = zigbee.resolveEntity(devices.bulb_color.ieeeAddr);
            const ep = device.zh.endpoints[0];
            ep.supportsInputCluster = vi.fn((c: string) => c === "manuSpecificInovelli");
            ep.getClusterAttributeValue = vi.fn((cluster: string) => (cluster === "manuSpecificInovelli" ? cachedMode : 0));
            ep.write = vi.fn(async () => {});
            ep.command = vi.fn(async () => {});
            return {ep, group: zigbee.groupByID(1)};
        };

        const reconcile = async (group: unknown, smartBulbMode: boolean) => {
            // biome-ignore lint/suspicious/noExplicitAny: same
            const ext = controller.getExtension("SmartBulbMode") as any;
            await ext.reconcileGroup(group, {
                controlling_switch: devices.bulb_color.ieeeAddr,
                smart_bulb_mode: smartBulbMode,
            });
            await flushPromises();
        };

        it("writes the smartBulbMode attribute when the device is out of sync", async () => {
            const {ep, group} = stubSwitch(SMART_BULB_MODE_OFF);
            await reconcile(group, true);
            expect(ep.write).toHaveBeenCalledWith("manuSpecificInovelli", {smartBulbMode: SMART_BULB_MODE_ON}, expect.anything());
        });

        it("does not write the attribute when the device already matches", async () => {
            const {ep, group} = stubSwitch(SMART_BULB_MODE_ON);
            await reconcile(group, true);
            expect(ep.write).not.toHaveBeenCalled();
        });

        // Regression: the reconciler used to force onOff=1 on the controlling
        // switch to "keep the bulbs energized". On a switch in smart bulb mode
        // the relay is already held closed by firmware, and genOnOff is a
        // logical state whose transitions are emitted to the switch's bound
        // group — so that write broadcast an ON to the whole room. Paired with
        // any automation that turns the group off, it produced an endless
        // off/on fight at the poll interval. The reconciler must never issue a
        // switching command.
        it("never sends a genOnOff command, even when the switch reads off", async () => {
            const {ep, group} = stubSwitch(SMART_BULB_MODE_OFF);
            await reconcile(group, true);
            expect(ep.command).not.toHaveBeenCalled();
        });

        it("never sends a genOnOff command when already in smart bulb mode", async () => {
            const {ep, group} = stubSwitch(SMART_BULB_MODE_ON);
            await reconcile(group, true);
            expect(ep.command).not.toHaveBeenCalled();
        });
    });
});
