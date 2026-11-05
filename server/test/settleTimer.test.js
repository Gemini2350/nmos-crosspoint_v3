// The wait for a registration to finish: quiet time, with an upper limit.
const test = require("node:test");
const assert = require("node:assert");
const { SettleTimer } = require("../dist/lib/settleTimer.js");

function setup(t) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let runs = 0;
    const timer = new SettleTimer(() => { runs++; }, 1000, 3000);
    return { timer, runs: () => runs };
}

test("runs quietMs after the last touch", (t) => {
    const { timer, runs } = setup(t);
    timer.touch();
    t.mock.timers.tick(999);
    assert.equal(runs(), 0);
    t.mock.timers.tick(1);
    assert.equal(runs(), 1);
});

test("a touch inside the quiet time pushes the run out", (t) => {
    const { timer, runs } = setup(t);
    timer.touch();
    t.mock.timers.tick(600);
    timer.touch();
    t.mock.timers.tick(600);
    assert.equal(runs(), 0);
    t.mock.timers.tick(400);
    assert.equal(runs(), 1);
});

test("a burst that never pauses still runs by maxWaitMs", (t) => {
    const { timer, runs } = setup(t);
    timer.touch();
    for (let at = 300; at < 3000; at += 300) {
        t.mock.timers.tick(300);
        timer.touch();
        assert.equal(runs(), 0, "too early at " + at);
    }
    t.mock.timers.tick(300);
    assert.equal(runs(), 1);
});

test("after a run the limit starts over", (t) => {
    const { timer, runs } = setup(t);
    timer.touch();
    t.mock.timers.tick(1000);
    assert.equal(runs(), 1);
    t.mock.timers.tick(10000);
    timer.touch();
    t.mock.timers.tick(999);
    assert.equal(runs(), 1);
    t.mock.timers.tick(1);
    assert.equal(runs(), 2);
});
