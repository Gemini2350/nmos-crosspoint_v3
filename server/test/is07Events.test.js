// Run with `npm test`, after `npm run build`: IS-07 monitor helpers.
const test = require("node:test");
const assert = require("node:assert/strict");
const ev = require("../dist/lib/is07Events");

const WS = "urn:x-nmos:transport:websocket";
const MQTT = "urn:x-nmos:transport:mqtt";

function bench() {
    const state = { senders: {}, flows: {}, devices: {}, senderActiveData: {} };
    state.devices.d1 = { controls: [{ type: "urn:x-nmos:control:events/v1.0", href: "http://h/x-nmos/events/v1.0/" }] };
    const add = (id, transport, src, tp, enabled = true) => {
        state.flows["f" + id] = { source_id: src, event_type: "boolean" };
        state.senders[id] = { transport, flow_id: "f" + id, device_id: "d1" };
        state.senderActiveData[id] = { master_enable: enabled, transport_params: [tp] };
    };
    add("a", WS, "src-a", { connection_uri: "ws://h:8870/ws", ext_is_07_source_id: "src-a", ext_is_07_rest_api_url: "http://h/x-nmos/events/v1.0/sources/src-a/" });
    add("b", WS, "src-b", { connection_uri: "ws://h:8870/ws" });
    add("c", WS, "src-c", { connection_uri: "ws://h:8870/ws" }, false);
    add("d", WS, "src-d", { connection_uri: "ws://other:1/ws", connection_authorization: true });
    add("m", MQTT, "src-m", { destination_host: "broker", destination_port: 1883, broker_protocol: "mqtt", broker_topic: "x-nmos/events/v1.0/sources/src-m", connection_status_broker_topic: "x-nmos/events/v1.0/connections/m" });
    add("n", MQTT, "src-n", { destination_host: "broker", destination_port: 1883, broker_protocol: "mqtt", broker_topic: "x-nmos/events/v1.0/sources/src-n", connection_status_broker_topic: null });
    state.senders.rtp = { transport: "urn:x-nmos:transport:rtp.mcast", flow_id: "x", device_id: "d1" };
    return state;
}

test("one WebSocket connection per server, one MQTT connection per broker", () => {
    const t = ev.eventTargets(bench());
    assert.equal(t.ws.length, 1);
    assert.equal(t.ws[0].uri, "ws://h:8870/ws");
    assert.deepEqual(t.ws[0].sources.map((s) => s.sourceId), ["src-a", "src-b"]);
    // The Events API from /active, else from the device's control.
    assert.equal(t.ws[0].sources[0].restUrl, "http://h/x-nmos/events/v1.0/sources/src-a/");
    assert.equal(t.ws[0].sources[1].restUrl, "http://h/x-nmos/events/v1.0/sources/src-b/");
    assert.equal(t.mqtt.length, 1);
    assert.equal(t.mqtt[0].url, "mqtt://broker:1883");
    assert.deepEqual(Object.keys(t.mqtt[0].topics).sort(), ["x-nmos/events/v1.0/sources/src-m", "x-nmos/events/v1.0/sources/src-n"]);
    assert.deepEqual(t.mqtt[0].statusTopics, { "x-nmos/events/v1.0/connections/m": ["m"] });
    assert.deepEqual(t.off, ["c"]);
    assert.deepEqual(t.skipped, [{ senderId: "d", reason: "needs authorization (IS-10)" }]);
});

test("secure MQTT and IPv6 brokers get their URL right", () => {
    const s = bench();
    s.senderActiveData.m.transport_params[0] = { destination_host: "fd00::5", destination_port: null, broker_protocol: "secure-mqtt", broker_topic: "t" };
    const t = ev.eventTargets(s);
    assert.ok(t.mqtt.some((m) => m.url === "mqtts://[fd00::5]:8883" && m.secure));
});

test("messages are read by their message_type", () => {
    const st = ev.parseEventMessage(JSON.stringify({ identity: { source_id: "s", flow_id: "f" }, event_type: "boolean",
        timing: { creation_timestamp: "1:2" }, payload: { value: true }, message_type: "state" }));
    assert.deepEqual(st, { type: "state", sourceId: "s", flowId: "f", eventType: "boolean", payload: { value: true }, created: "1:2" });
    assert.deepEqual(ev.parseEventMessage('{"timing":{},"message_type":"health"}'), { type: "health" });
    assert.deepEqual(ev.parseEventMessage('{"identity":{"source_id":"s"},"message_type":"shutdown"}'), { type: "shutdown", sourceId: "s" });
    assert.deepEqual(ev.parseEventMessage('{"active":false,"message_type":"connection_status"}'), { type: "connection_status", active: false });
    assert.equal(ev.parseEventMessage("not json"), null);
    assert.deepEqual(ev.parseEventMessage('{"message_type":"state","payload":{}}'), { type: "other" });
});

test("values read as the type says", () => {
    assert.deepEqual(ev.formatEventValue("boolean", { value: true }, null), { text: "true", kind: "on", detail: "true" });
    assert.deepEqual(ev.formatEventValue("boolean", { value: false }, null).kind, "off");
    // value / scale, decimals from the scale, unit from the event type
    assert.equal(ev.formatEventValue("number/temperature/C", { value: 215, scale: 10 }, null).text, "21.5 C");
    assert.equal(ev.formatEventValue("number/temperature/C", { value: 210, scale: 10 }, null).text, "21.0 C");
    // the type definition's unit wins
    assert.equal(ev.formatEventValue("number/level", { value: -18 }, { type: "number", unit: "dB" }).text, "-18 dB");
    assert.equal(ev.formatEventValue("number", { value: 1 / 3 }, null).text, "0.333");
    assert.equal(ev.formatEventValue("string", { value: "Fan warning" }, null).text, "Fan warning");
    // enums: the label of the value, with value and description in the detail
    const cond = { type: "number", values: [{ value: 0, label: "idle", description: "Studio condition is idle" }, { value: 2, label: "tx", description: "Studio condition is tx" }] };
    assert.deepEqual(ev.formatEventValue("number/enum/StudioCondition", { value: 2 }, cond), { text: "tx", kind: "val", detail: "tx (2) – Studio condition is tx" });
    const onOff = { type: "boolean", values: [{ value: false, label: "OFF", description: "Door closed" }, { value: true, label: "ON", description: "Door open" }] };
    assert.deepEqual(ev.formatEventValue("boolean/enum/OnOff", { value: true }, onOff), { text: "ON", kind: "on", detail: "ON (true) – Door open" });
    // an enum without its type definition shows the raw value
    assert.equal(ev.formatEventValue("number/enum/StudioCondition", { value: 2 }, null).text, "2");
});

test("health timestamps are seconds:nanoseconds in TAI", () => {
    assert.equal(ev.taiTimestamp(1000500), "1037:500000000");
});
