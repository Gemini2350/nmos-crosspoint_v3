// The text a device sends with an error response, shown to the user.
const test = require("node:test");
const assert = require("node:assert");
const { deviceErrorText, failedBecause } = require("../dist/lib/deviceError.js");

test("error and debug of an NMOS error body", () => {
    assert.equal(deviceErrorText({ code: 500, error: "Internal Server Error", debug: "activation modified during in-flight immediate activation" }),
        "Internal Server Error (activation modified during in-flight immediate activation)");
    assert.equal(deviceErrorText({ code: 400, error: "bad sender_id", debug: null }), "bad sender_id");
    assert.equal(deviceErrorText({ code: 500, error: "", debug: "only debug" }), "only debug");
});

test("no text when the body is not an NMOS error object", () => {
    assert.equal(deviceErrorText(undefined), "");
    assert.equal(deviceErrorText("<html>500</html>"), "");
    assert.equal(deviceErrorText({ code: 500 }), "");
});

test("a 500 with text reads like a 400 with text, without text the code stays", () => {
    assert.equal(failedBecause(500, { error: "Device refuses" }, "ERR_BAD_RESPONSE"), "answered 500: Device refuses");
    assert.equal(failedBecause(400, { error: "bad" }, "ERR_BAD_REQUEST"), "answered 400: bad");
    assert.equal(failedBecause(500, null, "ERR_BAD_RESPONSE"), "returned Error: ERR_BAD_RESPONSE");
});
