// Run with `npm test`, after `npm run build`: exercises the compiled helpers.
//
// fixtures/rtp-by-address.json is IS-04 and IS-05 JSON read from a running
// system: an ST 2022-7 SPG sender set, the ST 2110 gateway's receivers that
// were connected to it by transport file (sender_id null in IS-04 and IS-05),
// and an MXL receiver connected by name. Unicast addresses and site labels
// are replaced, ids, groups and ports are as read.
const test = require("node:test");
const assert = require("node:assert/strict");
const sdpTransform = require("sdp-transform");
const t = require("../dist/lib/transport");
const fx = require("./fixtures/rtp-by-address.json");

const SPG_VIDEO_1 = "1a87695b-4013-5f80-b572-78b8a592f083";
const SPG_VIDEO_2 = "d25458d4-c76b-5195-b8a6-75f811dc1557";
const SPG_AUDIO_1 = "40dd965a-8d07-51f2-bcea-04f374e2fe74";
const SPG_AUDIO_2 = "80b7c819-0238-502c-9d90-8e3836c04e3b";
const SPG_VIDEO_4 = "7fa259dc-7bf8-5dbf-969b-0f0d14136a76";
const GW_MXL_VIDEO = "0c8dda41-fb99-5577-b032-7cc8606e134a";
const GW_RX_SRC1_VIDEO = "b43953eb-4d5a-5c07-b1ce-ccd1d84247e6";
const GW_RX_SRC1_AUDIO = "2bc28379-2f4f-5192-859f-a5694b00de71";
const GW_RX_SRC2_VIDEO = "b262f59a-a67e-5ba0-b28b-afaabb64011f";
const GW_RX_SRC2_AUDIO = "7bbe6862-fcb0-51ed-bfc4-2190ac21a271";
const GW_RX_BMD1_VIDEO = "cfc8bc54-5ff2-5c3a-801c-10074c88ce35";
const GW_RX_BMD1_AUDIO = "366dcdbe-4020-51fa-9930-7082fd1a11b6";
const TILE_0 = "b5c9984a-727b-5cf6-83b9-fa352947018b";

const connected = (rxId) => t.connectedSenderId(fx.receivers[rxId], fx.receiverActive[rxId], fx.senderActive, fx.senders);

test("transport URNs fall into families", () => {
    assert.equal(t.transportFamily("urn:x-nmos:transport:rtp"), "rtp");
    assert.equal(t.transportFamily("urn:x-nmos:transport:rtp.mcast"), "rtp");
    assert.equal(t.transportFamily("urn:x-nmos:transport:rtp.ucast"), "rtp");
    assert.equal(t.transportFamily("rtp.mcast"), "rtp");
    assert.equal(t.transportFamily("urn:x-nmos:transport:mxl"), "mxl");
    assert.equal(t.transportFamily("mxl"), "mxl");
    assert.equal(t.transportFamily("urn:x-nmos:transport:websocket"), "websocket");
    assert.equal(t.transportFamily("urn:x-nmos:transport:mqtt"), "mqtt");
    assert.equal(t.transportFamily("urn:x-nmos:transport:srt"), "");
    assert.equal(t.transportFamily(""), "");
    assert.equal(t.transportFamily(undefined), "");
});

test("an rtp sender feeds an rtp.mcast receiver, never an MXL one", () => {
    assert.equal(t.transportsCompatible("urn:x-nmos:transport:rtp", "urn:x-nmos:transport:rtp.mcast"), true);
    assert.equal(t.transportsCompatible("urn:x-nmos:transport:rtp", "urn:x-nmos:transport:mxl"), false);
    assert.equal(t.transportsCompatible("mxl", "rtp"), false);
    assert.equal(t.transportsCompatible("mxl", "mxl"), true);
    // Unknown on either side: nothing to compare, the device decides.
    assert.equal(t.transportsCompatible("", "mxl"), true);
});

test("a flow pair needs the same essence and a compatible transport", () => {
    const rtpVideoTx = { type: "video", capabilities: { transport: "rtp" } };
    const mxlVideoTx = { type: "video", capabilities: { transport: "mxl" } };
    const rtpAudioTx = { type: "audio", capabilities: { transport: "rtp" } };
    const mxlVideoRx = { type: "video", capabilities: { transport: "mxl" } };
    assert.equal(t.flowsConnectable(mxlVideoRx, mxlVideoTx), true);
    assert.equal(t.flowsConnectable(mxlVideoRx, rtpVideoTx), false);
    assert.equal(t.flowsConnectable(mxlVideoRx, rtpAudioTx), false);
});

test("the SPG senders are ST 2022-7, whichever source says it", () => {
    const s = fx.senders[SPG_VIDEO_1];
    const sdp = sdpTransform.parse(fx.senderSdp[SPG_VIDEO_1]);
    assert.equal(t.senderIsRedundant(s, fx.senderActive[SPG_VIDEO_1], sdp), true);
    // SDP alone: a=group:DUP
    assert.equal(t.senderIsRedundant(s, undefined, sdp), true);
    // Interface bindings alone
    assert.equal(t.senderIsRedundant(s), true);
    // Switched off, every leg is disabled; it is still set up for two.
    assert.equal(fx.senderActive[SPG_VIDEO_4].master_enable, false);
    assert.equal(t.senderIsRedundant(fx.senders[SPG_VIDEO_4], fx.senderActive[SPG_VIDEO_4]), true);
    // One leg enabled is not redundant, even with two bindings.
    const oneLeg = { transport_params: [{ rtp_enabled: true }, { rtp_enabled: false }] };
    assert.equal(t.senderIsRedundant(s, oneLeg), false);
    // An SDP with a single media section overrides two bindings.
    const single = sdpTransform.parse("v=0\r\no=- 1 1 IN IP4 192.0.2.1\r\ns=x\r\nt=0 0\r\nm=video 5004 RTP/AVP 96\r\nc=IN IP4 239.1.1.1/32\r\n");
    assert.equal(t.senderIsRedundant(s, undefined, single), false);
    // MXL is never 2022-7.
    assert.equal(t.senderIsRedundant(fx.senders[GW_MXL_VIDEO]), false);
});

test("a receiver with two legs is ST 2022-7", () => {
    assert.equal(t.receiverIsRedundant(fx.receivers[GW_RX_SRC1_VIDEO], fx.receiverActive[GW_RX_SRC1_VIDEO]), true);
    assert.equal(t.receiverIsRedundant(fx.receivers[GW_RX_SRC1_VIDEO]), true);
    assert.equal(t.receiverIsRedundant(fx.receivers[GW_RX_BMD1_VIDEO], fx.receiverActive[GW_RX_BMD1_VIDEO]), false);
    assert.equal(t.receiverIsRedundant(fx.receivers[TILE_0]), false);
});

test("the gateway's receivers name no sender while they run", () => {
    // This is what the crosspoint used to rely on alone.
    for (const id of [GW_RX_SRC1_VIDEO, GW_RX_SRC1_AUDIO, GW_RX_SRC2_VIDEO, GW_RX_SRC2_AUDIO]) {
        assert.equal(fx.receivers[id].subscription.active, true, id);
        assert.equal(fx.receivers[id].subscription.sender_id, null, id);
        assert.equal(fx.receiverActive[id].sender_id, null, id);
        assert.equal(t.receiverNeedsActive(fx.receivers[id]), true, id);
    }
    assert.equal(t.receiverNeedsActive(fx.receivers[TILE_0]), false);
});

test("a receiver connected by transport file is matched to its sender by address", () => {
    // Source filter on both legs (source 2) and none at all (source 1).
    assert.equal(connected(GW_RX_SRC2_VIDEO), SPG_VIDEO_2);
    assert.equal(connected(GW_RX_SRC2_AUDIO), SPG_AUDIO_2);
    assert.equal(connected(GW_RX_SRC1_VIDEO), SPG_VIDEO_1);
    assert.equal(connected(GW_RX_SRC1_AUDIO), SPG_AUDIO_1);
});

test("a receiver's named sender wins over any address", () => {
    assert.equal(connected(TILE_0), fx.receivers[TILE_0].subscription.sender_id);
    const rx = { ...fx.receivers[GW_RX_SRC2_VIDEO], subscription: { active: true, sender_id: "named" } };
    assert.equal(t.connectedSenderId(rx, fx.receiverActive[GW_RX_SRC2_VIDEO], fx.senderActive, fx.senders), "named");
    const active = { ...fx.receiverActive[GW_RX_SRC2_VIDEO], sender_id: "from-is05" };
    assert.equal(t.connectedSenderId(fx.receivers[GW_RX_SRC2_VIDEO], active, fx.senderActive, fx.senders), "from-is05");
});

test("no address match means no connection", () => {
    // A stopped receiver has none, whatever it last joined.
    const stopped = { ...fx.receivers[GW_RX_SRC2_VIDEO], subscription: { active: false, sender_id: null } };
    assert.equal(t.connectedSenderId(stopped, fx.receiverActive[GW_RX_SRC2_VIDEO], fx.senderActive, fx.senders), "");
    // Its sender is not in the registry: nothing to name.
    assert.equal(connected(GW_RX_BMD1_VIDEO), "");
    // Running with no group joined.
    assert.equal(connected(GW_RX_BMD1_AUDIO), "");
    // A sender whose /active matches but is switched off does not count.
    const off = { ...fx.senderActive, [SPG_VIDEO_2]: { ...fx.senderActive[SPG_VIDEO_2], master_enable: false } };
    assert.equal(t.connectedSenderId(fx.receivers[GW_RX_SRC2_VIDEO], fx.receiverActive[GW_RX_SRC2_VIDEO], off, fx.senders), "");
    // IS-05 says switched off, IS-04 still says running.
    const offRx = { ...fx.receiverActive[GW_RX_SRC2_VIDEO], master_enable: false };
    assert.equal(t.connectedSenderId(fx.receivers[GW_RX_SRC2_VIDEO], offRx, fx.senderActive, fx.senders), "");
    // A different source on the same group is a different stream.
    const otherSrc = JSON.parse(JSON.stringify(fx.receiverActive[GW_RX_SRC2_VIDEO]));
    otherSrc.transport_params.forEach((l) => { l.source_ip = "192.0.2.250"; });
    assert.equal(t.connectedSenderId(fx.receivers[GW_RX_SRC2_VIDEO], otherSrc, fx.senderActive, fx.senders), "");
});

test("two senders on the same group and port are not guessed between", () => {
    const twin = JSON.parse(JSON.stringify(fx.senderActive[SPG_VIDEO_1]));
    const senders = { ...fx.senders, twin: { ...fx.senders[SPG_VIDEO_1], id: "twin" } };
    const active = { ...fx.senderActive, twin };
    assert.equal(t.connectedSenderId(fx.receivers[GW_RX_SRC1_VIDEO], fx.receiverActive[GW_RX_SRC1_VIDEO], active, senders), "");
    // Matching both legs beats matching one.
    twin.transport_params[1].destination_ip = "239.9.9.9";
    assert.equal(t.connectedSenderId(fx.receivers[GW_RX_SRC1_VIDEO], fx.receiverActive[GW_RX_SRC1_VIDEO], active, senders), SPG_VIDEO_1);
});
