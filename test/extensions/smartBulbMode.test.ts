// biome-ignore assist/source/organizeImports: import mocks first
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import * as data from "../mocks/data";
import {mockLogger} from "../mocks/logger";
import {flushPromises} from "../mocks/utils";
import {devices, resetGroupMembers} from "../mocks/zigbeeHerdsman";

import {Controller} from "../../lib/controller";
import {parseSmartBulbModeState} from "../../lib/extension/smartBulbMode";
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
});
