// 回归：保存请求在途期间新增的演员打点，不能被先返回的旧响应覆盖；
// 排队补发的下一次 PUT 必须携带最新打点。
const assert = require('assert');
const path = require('path');
const { sandbox, T, fixture, setTimers } = require(path.join(__dirname, 'harness.js'));

// 定时器设为 no-op：debounce 不自动触发，由测试直接驱动 saveRehearsal
setTimers({ setTimeout: () => 0, clearTimeout: () => {} });

async function main() {
  let resolveFirst = null;
  const putBodies = [];
  sandbox.api = async (p, opts) => {
    assert.strictEqual(opts.method, 'PUT');
    const body = JSON.parse(opts.body);
    putBodies.push(body);
    if (putBodies.length === 1) {
      await new Promise((res) => { resolveFirst = res; });   // 首次 PUT 挂起
    } else {
      await new Promise((r) => global.setTimeout(r, 1));
    }
    // 服务端原样持久化并回显它收到的内容
    return {
      beat_marks: body.beat_marks.map((m) => ({ ...m })),
      actor_marks: body.actor_marks.map((m) => ({ ...m })),
      clock_running: body.clock_running, clock_elapsed: body.clock_elapsed,
      name: body.name, notes: body.notes, status: body.status,
    };
  };

  T.setR(fixture());
  T.recordCurrentBeat();                 // 记录节点1，预建 2 个 actual_time=null 的演员行
  const p1 = T.saveRehearsal();          // 第一次 PUT 发出（旧 payload）
  await new Promise((r) => global.setTimeout(r, 5));
  assert.strictEqual(putBodies.length, 1);
  assert.strictEqual(putBodies[0].actor_marks.length, 2);
  assert.ok(putBodies[0].actor_marks.every((m) => m.actual_time === null));

  T.tapActor('b1', 'a1');                // 在途期间新增甲的到位打点（scheduleRhSave 排队）
  assert.strictEqual(T.actorMark('b1', 'a1').actual_time, 0);
  assert.strictEqual(T.R().actor_marks.length, 2);

  resolveFirst();                        // 旧响应返回
  await p1;
  await new Promise((r) => global.setTimeout(r, 20));

  // 1) 旧响应不得覆盖本地新打点
  assert.strictEqual(T.actorMark('b1', 'a1').actual_time, 0);
  assert.strictEqual(T.R().actor_marks.length, 2);

  // 2) 排队补发的第二次 PUT 已携带最新打点
  assert.ok(putBodies.length >= 2, 'queued PUT must be sent, got ' + putBodies.length);
  const a1 = putBodies[1].actor_marks.find((m) => m.beat_id === 'b1' && m.actor_id === 'a1');
  assert.strictEqual(a1.actual_time, 0);

  console.log('PASS save_concurrent.js (PUTs=' + putBodies.length + ')');
}

main().catch((e) => { console.error(e); process.exit(1); });
