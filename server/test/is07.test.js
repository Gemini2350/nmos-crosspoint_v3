// Run with `npm test`, after `npm run build`: IS-07 (Event & Tally) helpers.
const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../dist/lib/nmosConnectionPatch");
const t = require("../dist/lib/transport");
const rc = require("../dist/lib/receiverCaps");

const SRC = "6cbd0441-7882-44cd-9557-842243a0d618";
const WS = "urn:x-nmos:transport:websocket";
const MQTT = "urn:x-nmos:transport:mqtt";

test("a WebSocket receiver gets the sender's server, source and Events API", () => {
    const active = { master_enable: true, transport_params: [{
        connection_uri: "ws://10.0.0.5:8870/x-nmos/events/v1.0/ws", connection_authorization: false,
        ext_is_07_source_id: SRC, ext_is_07_rest_api_url: "http://10.0.0.5/x-nmos/events/v1.0/sources/" + SRC + "/" }] };
    assert.deepEqual(p.is07EndpointFromActive("websocket", active), {
        connection_uri: "ws://10.0.0.5:8870/x-nmos/events/v1.0/ws", connection_authorization: false,
        ext_is_07_source_id: SRC, ext_is_07_rest_api_url: "http://10.0.0.5/x-nmos/events/v1.0/sources/" + SRC + "/" });
});

test("what /active leaves out comes from IS-04: the flow's source and the device's Events API", () => {
    const active = { transport_params: [{ connection_uri: "ws://h/ws", connection_authorization: "auto" }] };
    const ep = p.is07EndpointFromActive("websocket", active, { sourceId: SRC, eventsHref: "http://h/x-nmos/events/v1.0" });
    assert.deepEqual(ep, { connection_uri: "ws://h/ws", ext_is_07_source_id: SRC,
        ext_is_07_rest_api_url: "http://h/x-nmos/events/v1.0/sources/" + SRC + "/" });
});

test("a sender without a resolved address or topic is refused", () => {
    assert.throws(() => p.is07EndpointFromActive("websocket", { transport_params: [{ connection_uri: null }] }), /connection_uri/);
    assert.throws(() => p.is07EndpointFromActive("websocket", { transport_params: [{ connection_uri: "auto" }] }), /connection_uri/);
    assert.throws(() => p.is07EndpointFromActive("mqtt", { transport_params: [{ destination_host: "auto", broker_topic: "x" }] }), /destination_host/);
    assert.throws(() => p.is07EndpointFromActive("mqtt", { transport_params: [{ destination_host: "b", broker_topic: null }] }), /broker_topic/);
    assert.throws(() => p.is07EndpointFromActive("rtp", { transport_params: [{}] }), /Not an IS-07/);
});

test("an MQTT receiver reads from the broker the sender publishes to, on the same topics", () => {
    const active = { transport_params: [{ destination_host: "broker.local", destination_port: 1883, broker_protocol: "mqtt",
        broker_authorization: false, broker_topic: "x-nmos/events/v1.0/sources/" + SRC, connection_status_broker_topic: null }] };
    assert.deepEqual(p.is07EndpointFromActive("mqtt", active), {
        source_host: "broker.local", source_port: 1883, broker_protocol: "mqtt", broker_authorization: false,
        broker_topic: "x-nmos/events/v1.0/sources/" + SRC, connection_status_broker_topic: null });
    // ext_is_07_source_id is a WebSocket parameter only.
    const ep = p.is07EndpointFromActive("mqtt", active, { sourceId: SRC, eventsHref: "http://h/x-nmos/events/v1.0/" });
    assert.equal(ep.ext_is_07_source_id, undefined);
    assert.equal(ep.ext_is_07_rest_api_url, "http://h/x-nmos/events/v1.0/sources/" + SRC + "/");
});

test("only parameters the receiver lists in /constraints are staged", () => {
    const ep = { connection_uri: "ws://h/ws", connection_authorization: false, ext_is_07_source_id: SRC, ext_is_07_rest_api_url: "http://h/s/" };
    const all = p.buildIs07ReceiverPatch("s1", ep, [{ connection_uri: {}, connection_authorization: {}, ext_is_07_source_id: {}, ext_is_07_rest_api_url: {} }], 1);
    assert.deepEqual(all, { sender_id: "s1", master_enable: true, activation: { mode: "activate_immediate" }, transport_params: [ep] });
    const core = p.buildIs07ReceiverPatch("s1", ep, [{ connection_uri: {}, connection_authorization: {} }], 1);
    assert.deepEqual(core.transport_params, [{ connection_uri: "ws://h/ws", connection_authorization: false }]);
    // Constraints not readable: IS-05 core parameters only.
    const none = p.buildIs07ReceiverPatch("s1", ep, null, 1);
    assert.deepEqual(none.transport_params, [{ connection_uri: "ws://h/ws", connection_authorization: false }]);
    assert.equal(none.transport_file, undefined);
    // One set of parameters per interface binding.
    assert.deepEqual(p.buildIs07ReceiverPatch(null, ep, null, 2).transport_params.length, 2);
});

test("disconnecting switches the receiver off and names no sender", () => {
    assert.deepEqual(p.buildIs07DisconnectPatch(), { sender_id: null, master_enable: false, activation: { mode: "activate_immediate" } });
});

test("event type wildcards replace whole words at the end only", () => {
    assert.equal(rc.eventTypeAccepted("boolean", "boolean"), true);
    assert.equal(rc.eventTypeAccepted("Boolean", "boolean"), false);
    assert.equal(rc.eventTypeAccepted("number/*", "number/temperature/C"), true);
    assert.equal(rc.eventTypeAccepted("number/*", "number/enum/StudioCondition"), true);
    assert.equal(rc.eventTypeAccepted("number/*", "number"), false);
    assert.equal(rc.eventTypeAccepted("number/*", "numbers/x"), false);
    assert.equal(rc.eventTypeAccepted("number/temperature/*", "number/temperature/F"), true);
    assert.equal(rc.eventTypeAccepted("number/temperature/*", "number/pressure/hPa"), false);
    assert.equal(rc.eventTypeAccepted("*", "string"), true);
    assert.equal(rc.eventTypeAccepted("number/tempera*", "number/temperature/C"), false);
    assert.equal(rc.eventTypeAccepted("number/*/C", "number/temperature/C"), false);
});

test("receiver caps with an event type wildcard accept the matching flows", () => {
    const sigs = { temp: { "urn:x-nmos:cap:format:event_type": "number/temperature/C" },
                   tally: { "urn:x-nmos:cap:format:event_type": "boolean" } };
    assert.deepEqual(rc.acceptedSignatures({ event_types: ["number/*"] }, sigs), ["temp"]);
    assert.deepEqual(rc.acceptedSignatures({ event_types: ["boolean", "number/temperature/*"] }, sigs), ["temp", "tally"]);
});

test("an event receiver that names no sender is matched by what it reads", () => {
    const senders = { a: { transport: WS }, b: { transport: WS }, m: { transport: MQTT } };
    const act = {
        a: { master_enable: true, transport_params: [{ connection_uri: "ws://h/ws", ext_is_07_source_id: "src-a" }] },
        b: { master_enable: true, transport_params: [{ connection_uri: "ws://h/ws", ext_is_07_source_id: "src-b" }] },
        m: { master_enable: true, transport_params: [{ destination_host: "broker", broker_topic: "x-nmos/events/v1.0/sources/src-m" }] },
    };
    const rxWs = { transport_params: [{ connection_uri: "ws://h/ws", ext_is_07_source_id: "src-b" }] };
    assert.equal(t.matchSenderByEventEndpoint(rxWs, act, senders, "websocket"), "b");
    // One server for both sources and no source named: no guess.
    assert.equal(t.matchSenderByEventEndpoint({ transport_params: [{ connection_uri: "ws://h/ws" }] }, act, senders, "websocket"), "");
    const rxMq = { transport_params: [{ source_host: "broker", broker_topic: "x-nmos/events/v1.0/sources/src-m" }] };
    assert.equal(t.matchSenderByEventEndpoint(rxMq, act, senders, "mqtt"), "m");
    assert.equal(t.matchSenderByEventEndpoint({ transport_params: [{ source_host: "other", broker_topic: "x-nmos/events/v1.0/sources/src-m" }] }, act, senders, "mqtt"), "");

    const receiver = { transport: WS, subscription: { active: true, sender_id: null } };
    assert.equal(t.receiverNeedsActive(receiver), true);
    assert.equal(t.connectedSenderId(receiver, rxWs, act, senders), "b");
    assert.equal(t.connectedSenderId(receiver, { master_enable: false, ...rxWs }, act, senders), "");
});

test("WebSocket and MQTT are different transports", () => {
    assert.equal(t.transportsCompatible(WS, MQTT), false);
    assert.equal(t.transportsCompatible(WS, WS), true);
    assert.equal(p.isIs07Kind("websocket"), true);
    assert.equal(p.isIs07Kind("mqtt"), true);
    assert.equal(p.isIs07Kind("rtp"), false);
});
