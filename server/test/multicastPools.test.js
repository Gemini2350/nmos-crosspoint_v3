// Multicast DHCP pools by bandwidth.
const test = require("node:test");
const assert = require("node:assert");
const mp = require("../dist/lib/multicastPools.js");

const DEFAULT = "239.30.0.0/16";
const DEFS = [{ maxMbps: 10, range: "239.41.0.0/24" }, { maxMbps: 2, range: "239.40.0.0/16" }];

test("pools are sorted by limit, the default pool last", () => {
    const pools = mp.buildPools(DEFAULT, DEFS);
    assert.deepEqual(pools.map((p) => p.key), ["2", "10", "default"]);
    assert.deepEqual(pools.map((p) => p.label), ["≤ 2 Mbit/s", "≤ 10 Mbit/s", "∞"]);
    assert.equal(mp.pairCount(pools[1]), 128);
    assert.equal(mp.pairCount(pools[2]), 32768);
});

test("a sender goes into the smallest pool covering its bitrate, the limit included", () => {
    const pools = mp.buildPools(DEFAULT, DEFS);
    const key = (mbps) => mp.poolForBitrate(pools, mbps).key;
    assert.equal(key(0.8), "2");
    assert.equal(key(2), "2");
    assert.equal(key(2.01), "10");
    assert.equal(key(10), "10");
    assert.equal(key(2600), "default");
    // unknown bitrate → default
    assert.equal(key(null), "default");
    assert.equal(key(0), "default");
    assert.equal(key(NaN), "default");
    // without limited pools everything is the default pool, as before
    assert.equal(mp.poolForBitrate(mp.buildPools(DEFAULT, []), 1).key, "default");
});

test("an address belongs to the pool it lies in, or to none", () => {
    const pools = mp.buildPools(DEFAULT, DEFS);
    assert.equal(mp.poolOfIp(pools, "239.40.12.7").key, "2");
    assert.equal(mp.poolOfIp(pools, "239.41.0.255").key, "10");
    assert.equal(mp.poolOfIp(pools, "239.41.1.0"), null);
    assert.equal(mp.poolOfIp(pools, "239.30.0.5").key, "default");
    assert.equal(mp.poolOfIp(pools, "239.92.252.5"), null);
    assert.equal(mp.poolOfIp(pools, "nonsense"), null);
});

test("a valid configuration has no errors", () => {
    assert.deepEqual(mp.validatePools(DEFAULT, DEFS), []);
    assert.deepEqual(mp.validatePools(DEFAULT, []), []);
});

test("overlaps, duplicate limits, bad limits and bad ranges are reported", () => {
    const errs = (defs, def = DEFAULT) => mp.validatePools(def, defs);
    assert.match(errs([{ maxMbps: 2, range: "239.30.5.0/24" }])[0], /239\.30\.5\.0\/24 .* and 239\.30\.0\.0\/16 .*overlap/);
    assert.match(errs([{ maxMbps: 2, range: "239.40.0.0/16" }, { maxMbps: 10, range: "239.40.128.0/17" }])[0], /overlap/);
    assert.match(errs([{ maxMbps: 2, range: "239.40.0.0/16" }, { maxMbps: 2, range: "239.41.0.0/16" }])[0], /Two pools have the limit ≤ 2 Mbit\/s/);
    assert.match(errs([{ maxMbps: 0, range: "239.40.0.0/16" }])[0], /limit must be a number/);
    assert.match(errs([{ maxMbps: "abc", range: "239.40.0.0/16" }])[0], /limit must be a number/);
    assert.match(errs([{ maxMbps: 2, range: "239.40.0.0" }])[0], /no CIDR range/);
    assert.match(errs([{ maxMbps: 2, range: "10.0.0.0/8" }])[0], /not a multicast range/);
    assert.match(errs([], "239.300.0.0/16")[0], /Default pool/);
});

test("stored definitions: numbers, trimmed, sorted, empty rows dropped", () => {
    assert.deepEqual(mp.normalisePoolDefs([
        { maxMbps: "10", range: " 239.41.0.0/24 " },
        { maxMbps: "", range: "" },
        { maxMbps: "1,5", range: "239.40.0.0/16" },
    ]), [{ maxMbps: 1.5, range: "239.40.0.0/16" }, { maxMbps: 10, range: "239.41.0.0/24" }]);
    assert.deepEqual(mp.normalisePoolDefs(undefined), []);
});

test("pools carry their names; where a pool is shown, its name stands for it", () => {
    const pools = mp.buildPools(DEFAULT, [{ maxMbps: 2, range: "239.40.0.0/16", name: " Audio " }, { maxMbps: 10, range: "239.41.0.0/24" }], "Video");
    assert.deepEqual(pools.map((p) => p.name), ["Audio", "", "Video"]);
    assert.deepEqual(pools.map((p) => mp.poolTitle(p)), ["Audio", "≤ 10 Mbit/s", "Video"]);
    assert.equal(mp.poolTitle(null), "");
    assert.equal(mp.poolName("x".repeat(60)).length, mp.MAX_POOL_NAME);
});

test("two pools may not share a name, case aside; no name is fine", () => {
    assert.deepEqual(mp.validatePools(DEFAULT, [{ maxMbps: 2, range: "239.40.0.0/16", name: "Audio" }, { maxMbps: 10, range: "239.41.0.0/24" }], ""), []);
    assert.match(mp.validatePools(DEFAULT, [{ maxMbps: 2, range: "239.40.0.0/16", name: "Audio" }, { maxMbps: 10, range: "239.41.0.0/24", name: "audio" }])[0],
        /Two pools are named "Audio"/);
    assert.match(mp.validatePools(DEFAULT, [{ maxMbps: 2, range: "239.40.0.0/16", name: "Video" }], "video")[0], /Two pools are named/);
});

test("stored definitions keep a name only when there is one", () => {
    assert.deepEqual(mp.normalisePoolDefs([{ maxMbps: "2", range: "239.40.0.0/16", name: "  " }, { maxMbps: "10", range: "239.41.0.0/24", name: " Multi " }]),
        [{ maxMbps: 2, range: "239.40.0.0/16" }, { maxMbps: 10, range: "239.41.0.0/24", name: "Multi" }]);
});
