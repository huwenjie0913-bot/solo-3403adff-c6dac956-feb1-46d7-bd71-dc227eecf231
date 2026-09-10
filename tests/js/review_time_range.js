// 回归：rvTimeRange 必须同时覆盖计划与实测时刻。
// 末节点计划 5s、实测 9s（含演员打点）时，时间轴/回放上限应为 9s。
const assert = require('assert');
const path = require('path');
const { T, reviewV } = require(path.join(__dirname, 'harness.js'));

function beat(id, name, planned, actual, actorTimes) {
  return {
    beat_id: id, name, time: planned, planned, actual,
    delta: actual === null ? null : +(actual - planned).toFixed(2),
    note: '', status: actual === null ? 'missing' : (actual - planned > 1 ? 'late' : 'ok'),
    actors: actorTimes.map(([aid, nm, color, at, x, y]) => ({
      actor_id: aid, actor_name: nm, color, beat_id: id, beat_name: name,
      planned, plan_x: 1, plan_y: 4, plan_facing: 0,
      actual_time: at, delta: at === null ? null : +(at - planned).toFixed(2),
      x, y, pos_dev: x === null ? null : Math.hypot(x - 1, y - 4),
      absent: false, note: '',
      status: at === null ? 'missed' : (at - planned > 1 ? 'late' : 'ok'),
    })),
  };
}

// 场景 1：只有计划时刻，范围 0~5
T.setV(reviewV([
  beat('b1', '节点1', 0, 0, [['a1', '甲', '#e8734a', 0, null, null], ['a2', '乙', '#3f8fdd', 0, null, null]]),
  beat('b2', '节点2', 5, 5, [['a1', '甲', '#e8734a', 5, null, null], ['a2', '乙', '#3f8fdd', 5, null, null]]),
]));
let [lo, hi] = T.rvTimeRange();
assert.strictEqual(lo, 0, '计划场景下限');
assert.strictEqual(hi, 5, '计划场景上限应覆盖末节点计划 5s');

// 场景 2：末节点计划 5s，节点实测 9s，且演员打点到 9.2s
T.setV(reviewV([
  beat('b1', '节点1', 0, 0, [['a1', '甲', '#e8734a', 0, null, null], ['a2', '乙', '#3f8fdd', 0, null, null]]),
  beat('b2', '节点2', 5, 9, [['a1', '甲', '#e8734a', 9.2, 9.5, 4], ['a2', '乙', '#3f8fdd', 8.8, null, null]]),
]));
[lo, hi] = T.rvTimeRange();
assert.strictEqual(lo, 0, '实测场景下限仍为 0');
assert.ok(hi >= 9.2, '上限必须覆盖最晚实测 9.2s，实际 ' + hi);

// 场景 3：节点漏记但某演员有打点，范围仍要覆盖该打点
T.setV(reviewV([
  beat('b1', '节点1', 0, 0, [['a1', '甲', '#e8734a', 0, null, null]]),
  beat('b2', '节点2', 5, null, [['a1', '甲', '#e8734a', 7.5, null, null]]),
]));
[lo, hi] = T.rvTimeRange();
assert.ok(hi >= 7.5, '节点漏记但演员打点 7.5s 也应覆盖，实际 ' + hi);

console.log('PASS review_time_range.js');
