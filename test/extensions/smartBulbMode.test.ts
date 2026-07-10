// biome-ignore assist/source/organizeImports: import mocks first
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import * as data from "../mocks/data";
import {mockLogger} from "../mocks/logger";
import {flushPromises} from "../mocks/utils";
import {devices, resetGroupMembers} from "../mocks/zigbeeHerdsman";

import {Controller} from "../../lib/controller";
import {parseSmartBulbModeState} from "../../lib/extension/smartBulbMode";
import type Device from "../../lib/model/device";
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

    describe("adopting device-side changes into config", () => {
        let controller: Controller;
        const switchIeee = devices.bulb_color.ieeeAddr; // any configured, interviewed device; the handler is cluster-agnostic

        const state = (message: KeyValue, entity: Device) => ({entity, message, payload: message}) as never;

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
            settings.set(["groups", "1", "controlling_switch"], switchIeee);
            settings.set(["groups", "1", "smart_bulb_mode"], false);
        });

        const getExt = () =>
            controller.getExtension("SmartBulbMode") as never as {
                rebuildControllingSwitchIndex: () => void;
                onPublishEntityState: (data: unknown) => Promise<void>;
            };

        const sbm = (id: number) => (settings.getGroup(id) as unknown as {smart_bulb_mode?: boolean}).smart_bulb_mode;

        it("persists a UI/device smartBulbMode change to the group's smart_bulb_mode", async () => {
            const ext = getExt();
            ext.rebuildControllingSwitchIndex();
            const device = controller.zigbee.resolveEntity(switchIeee) as Device;

            await ext.onPublishEntityState(state({smartBulbMode: "Smart Bulb Mode"}, device));
            await flushPromises();

            expect(sbm(1)).toBe(true);
        });

        it("persists a turn-off the same way", async () => {
            settings.set(["groups", "1", "smart_bulb_mode"], true);
            const ext = getExt();
            ext.rebuildControllingSwitchIndex();
            const device = controller.zigbee.resolveEntity(switchIeee) as Device;

            await ext.onPublishEntityState(state({smartBulbMode: "Disabled"}, device));
            await flushPromises();

            expect(sbm(1)).toBe(false);
        });

        it("does not write config when already in sync", async () => {
            settings.set(["groups", "1", "smart_bulb_mode"], true);
            const ext = getExt();
            ext.rebuildControllingSwitchIndex();
            const spy = vi.spyOn(settings, "changeEntityOptions");
            const device = controller.zigbee.resolveEntity(switchIeee) as Device;

            await ext.onPublishEntityState(state({smartBulbMode: "Smart Bulb Mode"}, device));
            await flushPromises();

            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        });

        it("ignores reports while the device is mid-interview (re-pair guard)", async () => {
            const ext = getExt();
            ext.rebuildControllingSwitchIndex();
            const device = controller.zigbee.resolveEntity(switchIeee) as Device;
            const interviewed = vi.spyOn(device, "interviewed", "get").mockReturnValue(false);

            await ext.onPublishEntityState(state({smartBulbMode: "Smart Bulb Mode"}, device));
            await flushPromises();

            expect(sbm(1)).toBe(false);
            interviewed.mockRestore();
        });

        it("ignores devices that are not a controlling switch", async () => {
            const ext = getExt();
            ext.rebuildControllingSwitchIndex();
            const other = controller.zigbee.resolveEntity(devices.bulb.ieeeAddr) as Device;

            await ext.onPublishEntityState(state({smartBulbMode: "Smart Bulb Mode"}, other));
            await flushPromises();

            expect(sbm(1)).toBe(false);
        });

        it("ignores state updates that don't carry smartBulbMode", async () => {
            const ext = getExt();
            ext.rebuildControllingSwitchIndex();
            const spy = vi.spyOn(settings, "changeEntityOptions");
            const device = controller.zigbee.resolveEntity(switchIeee) as Device;

            await ext.onPublishEntityState(state({state: "ON"}, device));
            await flushPromises();

            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        });
    });
});
