"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const source = html.match(/<script id="pace-codec">([\s\S]*?)<\/script>/)[1];
vm.runInThisContext(source, {filename:"pace-codec.js"});
const C = globalThis.PaceCodec;
const original = fs.readFileSync(path.join(__dirname, "samples", "pace_1_123872836283764.bin"));
const parsed = C.decode(original);
let cases = 0;
function test(name, run) { run(); cases++; console.log(`PASS ${name}`); }
function copy() { return structuredClone(parsed); }
function corrupt(offset, value, size = 4) {
  const bytes = Buffer.from(original);
  if (size === 1) bytes.writeUInt8(value, offset);
  else if (size === 2) bytes.writeUInt16LE(value, offset);
  else bytes.writeUInt32LE(value, offset);
  return bytes;
}
test("原始样本：240 段，5,944 字节，所有业务字段正确", () => {
  assert.equal(original.length, 5944);
  assert.equal(parsed.strategyId, "123872836283764");
  assert.equal(parsed.strategyName, "配速策略 Mock 240段");
  assert.equal(parsed.sportType, 1);
  assert.equal(parsed.routeId, 1794274132);
  assert.equal(parsed.strategyVersion, 1);
  assert.equal(parsed.segmentCount, 240);
  assert.equal(parsed.targetDistance, 240000000);
  assert.equal(parsed.targetTime, 288000000);
  assert.equal(parsed.targetPace, 1200);
  parsed.segments.forEach((s, i) => assert.deepEqual(s, {index:i, intervalTargetTime:1200000, intervalTargetDistance:1000000, intervalTargetPace:1200, reserved:[0,0]}));
});
test("解析后重新生成，与样本逐字节一致", () => assert.deepEqual(Buffer.from(C.encode(parsed)), original));
test("内置样本与输入文件逐字节一致", () => {
  const encoded = JSON.parse(html.match(/<script id="embedded-sample" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(Buffer.from(encoded, "base64"), original);
});
test("下载文件名只有策略 ID，兼容原始带前缀样本", () => {
  assert.equal(C.filename(parsed), "123872836283764.bin");
  assert.deepEqual(C.filenameWarnings("pace_1_123872836283764.bin", parsed), []);
  assert.deepEqual(C.filenameWarnings("123872836283764.bin", parsed), []);
  assert.equal(C.filenameWarnings("2.bin", parsed).length, 1);
});
test("uint64 最大 ID 无损往返，JSON 使用字符串", () => {
  const d = copy(); d.strategyId = "18446744073709551615";
  const bytes = C.encode(d);
  assert.equal(new DataView(bytes.buffer).getBigUint64(8, true), (1n << 64n) - 1n);
  assert.equal(C.decode(bytes).strategyId, d.strategyId);
  assert.equal(C.decode(C.encode(JSON.parse(JSON.stringify(d)))).strategyId, d.strategyId);
});
test("uint32 边界及零值可选字段", () => {
  const d = copy();
  for (const key of ["targetDistance", "targetTime", "targetPace", "sportType", "routeId", "strategyVersion"]) d[key] = C.U32;
  for (const key of ["intervalTargetDistance", "intervalTargetTime", "intervalTargetPace"]) d.segments[0][key] = C.U32;
  assert.deepEqual(C.decode(C.encode(d)), d);
  d.routeId = 0; d.sportType = 0; d.strategyVersion = 0;
  assert.deepEqual(C.decode(C.encode(d)), d);
});
test("合法 UTF-8 名称边界：127 字节、中文、emoji、BOM", () => {
  for (const name of ["a".repeat(127), "中".repeat(42) + "a", "🏃".repeat(31) + "中", "\uFEFF策略"]) {
    const d = copy(); d.strategyName = name;
    assert.equal(C.decode(C.encode(d)).strategyName, name);
  }
});
test("拒绝超长、NUL、空名称及孤立代理项，不截断 UTF-8", () => {
  for (const name of ["a".repeat(128), "中".repeat(43), "a\0b", "", "\ud800"]) {
    const d = copy(); d.strategyName = name; assert.throws(() => C.encode(d));
  }
});
test("拒绝零 ID、越界 ID、数字类型 ID 和非十进制 ID", () => {
  for (const id of ["0", "18446744073709551616", 123, "1e6", "-1", "1.5", "", " 123"]) {
    const d = copy(); d.strategyId = id; assert.throws(() => C.encode(d));
  }
});
test("错误魔数、格式版本、头长、段长均拒绝", () => {
  for (const bytes of [corrupt(0, 0), corrupt(4, 2, 2), corrupt(6, 176, 2), corrupt(32, 16)]) assert.throws(() => C.decode(bytes));
});
test("过短、截断、尾部多字节、超大段数、零段均拒绝", () => {
  for (const bytes of [original.subarray(0, 183), original.subarray(0, -1), Buffer.concat([original, Buffer.from([0])]), corrupt(28, C.U32), corrupt(28, 0)]) assert.throws(() => C.decode(bytes));
  const empty = Buffer.from(original.subarray(0,184)); empty.writeUInt32LE(0,28); assert.throws(() => C.decode(empty));
});
test("头部与分段保留字段非零，包含末段保留字段，均拒绝", () => {
  for (const offset of [176,180,200,204,184 + 239 * 24 + 16,184 + 239 * 24 + 20]) assert.throws(() => C.decode(corrupt(offset, 1)));
});
test("名称无 NUL、非法 UTF-8、非零填充均拒绝", () => {
  const noNul = Buffer.from(original); noNul.fill(65, 48, 176); assert.throws(() => C.decode(noNul));
  const invalid = Buffer.from(original); invalid[48] = 255; assert.throws(() => C.decode(invalid));
  const padding = Buffer.from(original); padding[175] = 65; assert.throws(() => C.decode(padding));
});
test("全部正数目标的零值/溢出/小数/NaN/字符串均拒绝", () => {
  for (const key of ["targetDistance", "targetTime", "targetPace"]) {
    for (const value of [0,-1,C.U32+1,1.5,NaN,"1200"]) { const d = copy(); d[key] = value; assert.throws(() => C.encode(d)); }
  }
  for (const key of ["intervalTargetDistance", "intervalTargetTime", "intervalTargetPace"]) {
    for (const value of [0,-1,C.U32+1,1.5,NaN,"1200"]) { const d = copy(); d.segments[239][key] = value; assert.throws(() => C.encode(d)); }
  }
  for (const offset of [16,36,40,188,192,196]) assert.throws(() => C.decode(corrupt(offset, 0)));
});
test("分段序号、数量、保留字段与 JSON 类型错误均拒绝", () => {
  for (const change of [d => {d.segments[239].index=0;}, d => {d.segmentCount--;}, d => {d.reserved=[0,1];}, d => {d.segments[1].reserved=[];}, d => {d.sportType="1";}]) {
    const d = copy(); change(d); assert.throws(() => C.encode(d));
  }
  assert.throws(() => C.decode(corrupt(184 + 239 * 24, 0)));
});
test("总体与分段不一致仍可编码，直接保留输入配速", () => {
  const d = copy(); d.targetDistance = 1; d.targetTime = 2; d.targetPace = 3; d.segments[0].intervalTargetPace = 4;
  assert.deepEqual(C.decode(C.encode(d)), d);
});
test("不使用固定分段业务上限，1 段及 10,001 段可编码", () => {
  for (const count of [1,10001]) {
    const d = copy(); d.segments = Array.from({length:count},(_,i) => ({...parsed.segments[0], index:i, reserved:[0,0]})); d.segmentCount=count;
    const bytes=C.encode(d); assert.equal(bytes.length,184+count*24); assert.equal(C.decode(bytes).segmentCount,count);
  }
});
test("BigInt 精确计算分段汇总，支持带 byteOffset 的输入", () => {
  assert.deepEqual(C.totals(parsed), {distance:240000000n, time:288000000n});
  const padded = Buffer.concat([Buffer.from([1,2,3]),original,Buffer.from([4])]);
  assert.deepEqual(C.decode(padded.subarray(3,-1)), parsed);
});
test("展示采用整数舍入，覆盖公英制半分位、毫秒进位和配速向下取整", () => {
  assert.equal(C.formatDistance(1005000),"1.01 km");
  assert.equal(C.formatDistance(1004999),"1.00 km");
  assert.equal(C.formatDistance(25146,true),"0.02 mi");
  assert.equal(C.formatDistance(25145,true),"0.02 mi");
  assert.equal(C.formatDistance(804672,true),"0.50 mi");
  assert.equal(C.formatDistance(201168,true),"0.13 mi");
  assert.equal(C.formatDistance(201167,true),"0.12 mi");
  assert.equal(C.formatDistance(240000000,true),"149.13 mi");
  assert.equal(C.formatDuration(599499),"00:09:59");
  assert.equal(C.formatDuration(599500),"00:10:00");
  assert.equal(C.formatDuration(288000000),"80:00:00");
  assert.equal(C.formatPace(1200,true),"32:11 /mi");
  assert.equal(C.formatPace(300),"5:00 /km");
});
console.log(`\n${cases} 项协议验证通过。`);
