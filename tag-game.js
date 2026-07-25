/* toio 2台の鬼ごっこ＋救助・仕切り直し
   Thanks to p5.toio https://tetunori.github.io/p5.toio/
   接続処理・マット描画・キューブ描画は sample.js のパターンを踏襲する。
*/

// ==== マット・ゲームパラメータ定数（Issue #1 のパラメータ表と一致させる） ====
const MAT = {
  minX: 98,
  maxX: 402,
  minY: 142,
  maxY: 358,
  centerX: 250,
  centerY: 250,
}; // P5tId.SimpleTileMat の実測値
const SAFE_MARGIN = 30; // マット内側の安全マージン
const WALL_RANGE = 60; // 壁反発が効き始める距離
const LEAD_TIME = 0.3; // 鬼の先読み秒数
const CATCH_DIST = 40; // 捕獲判定距離
const CATCH_HOLD_MS = 300; // 捕獲成立に必要な継続時間
const LOST_MS = 800; // 座標ロスト判定時間
const STUCK_EPS = 5; // これ未満の移動量は「動いていない」とみなす
const STUCK_MS = 1200; // マット内スタック判定時間
const BACK_MS = 600; // 後退の基本時間
const RETRY_MAX = 3; // 救助リトライ上限
const RESCUE_TIMEOUT = 10000; // 救助断念までの時間
const REGROUP_WAIT = 2000; // 仕切り直しの待機時間
const SPEED = 60; // 通常速度（有効値域は 8..115。0 と ±8..115 以外は無効）
const RESCUE_SPEED = 40; // 救助時の低速
const BUMP_MS = 400; // 押し出し時間
const MOVE_INTERVAL = 200; // BLE コマンドの最短送信間隔（毎フレーム送ると詰まるため間引く）
const STEP = 80; // 逃走時の目標点までの距離
const W_AWAY = 1.0; // 鬼からの反発重み
const W_WALL = 1.5; // 壁からの反発重み
const APPROACH_DIST = 60; // 救助時に横へ回り込む距離
const ARRIVE_DIST = 25; // 接近完了とみなす距離
const VEL_EPS = 1; // これ未満の速度では進行方向を更新しない
const VEL_SMOOTH = 0.3; // 速度の指数移動平均係数（座標ノイズで先読み点が暴れるのを抑える）

// 効果音ID（P5tCube.seId 相当。未対応バージョンでも落ちないよう playSound() 側でガードする）
const SE_CATCH = 9; // effect1 相当（捕獲成立時）
const SE_RESCUE = 10; // effect2 相当（救助成功時）

// マット描画レイアウト（sample.js の設計値を踏襲。cube座標→画面座標のmap()にはMAT定数を使う）
const BASE_W = 600;
const BASE_H = 500;
const MAT_X = 50;
const MAT_Y = 50;
const MAT_W = 500;
const MAT_H = 355;
const COLOR_MAIN = [0, 133, 250, 100]; // 少し透明なシアン

// ==== グローバル状態 ====
const cubes = []; // P5tCube（接続順）
const states = []; // 各キューブの CubeState
let phase = "WAITING"; // "WAITING" | "CHASE" | "RESCUE" | "REGROUP" | "HELP_NEEDED" | "PAUSED"
let chaserIdx = 0;
let runnerIdx = 1;

let connectBtn; // 接続ボタン
let fsBtn; // 全画面表示ボタン

let catchSince = null; // CHASE中、捕獲距離内に入り続けている開始時刻
let rescue = null; // RESCUE/HELP_NEEDED中の救助コンテキスト
let regroupUntil = 0; // REGROUP待機の終了時刻
let pausedFromPhase = null; // PAUSEDに入る直前のphase（スペースキーで復帰するため）
let pausedAt = 0; // PAUSEDに入った時刻（復帰時に各期限を停止時間ぶん後ろへずらす）
let blinkOn = false; // HELP_NEEDED中のトラブル機LED点滅の状態
let lastBlinkAt = 0; // 直前の点滅切り替え時刻

// ==== ベクトルユーティリティ ====
// p5.toioの座標がプレーンな数値のため、p5.Vectorへの変換を挟まず{x,y}のまま扱う
function vAdd(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}
function vSub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}
function vScale(a, s) {
  return { x: a.x * s, y: a.y * s };
}
function vLen(a) {
  return Math.sqrt(a.x * a.x + a.y * a.y);
}
function vNorm(a) {
  const len = vLen(a);
  if (len === 0) return { x: 0, y: 0 };
  return { x: a.x / len, y: a.y / len };
}
function vDist(a, b) {
  return vLen(vSub(a, b));
}

// ==== CubeState 生成 ====
function makeCubeState() {
  return {
    pos: null, // 現在の有効座標。ロスト中はnull
    prevPos: null,
    velocity: { x: 0, y: 0 }, // 座標単位/秒
    lastValidPos: null, // 最後に読めた座標
    lastHeading: null, // 最後の進行方向（正規化済み）。救助時の後退方向に使う
    lostSince: null, // 座標を失った時刻(millis)
    stillAnchor: null, // スタック判定の基準座標（ここからSTUCK_EPS以上離れたら「動いた」）
    lastMoveAt: 0, // 最後に基準座標からSTUCK_EPS以上離れた時刻(millis)
    lastCmdAt: 0, // 最後にBLEコマンドを送った時刻
  };
}

// ==== p5 ライフサイクル ====
function setup() {
  // 初期設定（ボタン配置はsample.jsと同様）
  createCanvas(windowWidth, windowHeight);
  connectBtn = createButton("toioを接続する（2台必要）");
  connectBtn.position(20, 20);
  connectBtn.mousePressed(connectToio);
  fsBtn = createButton("全画面表示");
  fsBtn.position(190, 20);
  fsBtn.mousePressed(toggleFullscreen);
}

function connectToio() {
  // toioのキューブとの接続（Web Bluetoothの制約でユーザー操作イベント内からのみ呼べる）
  P5tCube.connectNewP5tCube().then((cube) => {
    cubes.push(cube);
    states.push(makeCubeState());
    cube.turnLightOn("white");
    connectBtn.html(cubes.length < 2 ? "次のtoioを接続" : "接続済み（2台）");

    // 2台そろうまではゲームロジックを動かさない。そろった瞬間にCHASEを開始する
    if (cubes.length >= 2 && phase === "WAITING") {
      enterChase();
    }
  });
}

function toggleFullscreen() {
  fullscreen(!fullscreen());
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

function keyPressed() {
  // キーボード操作
  if (key === "c" || key === "C") connectToio();
  if (key === "f" || key === "F") toggleFullscreen();
  if (key === "r" || key === "R") {
    // 強制的に仕切り直しへ戻す（HELP_NEEDEDからの手動復帰も兼ねる）
    if (cubes.length >= 2) enterRegroup();
  }
  if (key === " ") togglePause();
}

function togglePause() {
  if (phase === "PAUSED") {
    // 直前のphaseへ復帰。停止していた時間ぶん各期限を後ろへずらす。
    // ずらさないと、長く止めただけで救助タイムアウトや捕獲が勝手に成立してしまう
    const pausedMs = millis() - pausedAt;
    if (rescue !== null) {
      rescue.startedAt += pausedMs;
      rescue.nextActAt += pausedMs;
    }
    regroupUntil += pausedMs;
    if (catchSince !== null) catchSince += pausedMs;

    phase = pausedFromPhase || "CHASE";
    pausedFromPhase = null;
    resetStuckDetection(); // 停止していた時間をスタック判定に持ち越さない
  } else {
    pausedFromPhase = phase;
    pausedAt = millis();
    phase = "PAUSED";
    // 毎フレーム送ると詰まるため、停止コマンドは1回だけ送る
    cubes.forEach((cube) => cube.move(0, 0, 100));
  }
}

function draw() {
  // メインループ: 状態更新 → フェーズ処理 → 描画
  updateStates();
  updatePhase();

  background(240, 252, 257); // 水色

  const scaleFactor = min(width / BASE_W, height / BASE_H);
  push(); // 別座標系(マット設計座標)へ一時的に移動して描画し、popで戻す
  translate(width / 2, height / 2);
  scale(scaleFactor);
  translate(-BASE_W / 2, -BASE_H / 2);

  drawMat();
  if (cubes.length < 2) {
    drawWaitingMessage();
  } else {
    drawCubes();
  }
  pop();

  drawHud();
}

// ==== 状態更新 ====
function updateStates() {
  // 毎フレーム、各キューブの座標・速度・進行方向・ロスト/スタック検知用の時刻を更新する
  const now = millis();
  const dtSec = deltaTime / 1000;

  cubes.forEach((cube, i) => {
    const st = states[i];

    if (typeof cube.x === "number" && typeof cube.y === "number") {
      // --- 座標が読めている場合 ---
      const newPos = { x: cube.x, y: cube.y };

      // 速度はdeltaTimeで正規化して求める。deltaTimeが0の瞬間はゼロ割りを避けて前回値を保持する。
      // 生の差分は1フレーム分の座標ノイズをそのまま拾うため、指数移動平均で均してから使う
      if (st.pos !== null && dtSec > 0) {
        const rawVel = vScale(vSub(newPos, st.pos), 1 / dtSec);
        st.velocity = vAdd(
          vScale(st.velocity, 1 - VEL_SMOOTH),
          vScale(rawVel, VEL_SMOOTH)
        );
      }
      // 鬼の先読み・救助時の後退方向に使うため、ある程度動いているときだけ進行方向を更新する
      if (vLen(st.velocity) > VEL_EPS) {
        st.lastHeading = vNorm(st.velocity);
      }

      // スタック判定は「基準座標からSTUCK_EPS以上離れたか」で見る。
      // 前フレームとの差分で見ると、60fpsでは正常走行中でも1フレームの移動量が
      // STUCK_EPSを下回るため、走れているのに常時スタック扱いになってしまう
      if (st.stillAnchor === null || vDist(newPos, st.stillAnchor) >= STUCK_EPS) {
        st.stillAnchor = newPos;
        st.lastMoveAt = now;
      }

      st.prevPos = st.pos;
      st.pos = newPos;
      st.lastValidPos = newPos;
      st.lostSince = null;
    } else {
      // --- マット外などで座標が読めない場合 ---
      st.pos = null;
      st.stillAnchor = null; // 復帰時に基準を取り直す（ロスト中の停止をスタックとして数えない）
      if (st.lostSince === null) st.lostSince = now;
    }
  });
}

function updatePhase() {
  // 2台そろうまではゲームロジックを一切動かさない
  if (cubes.length < 2) {
    phase = "WAITING";
    return;
  }
  if (phase === "WAITING") {
    // 通常はconnectToio()内で遷移済みだが、念のためここでも開始する
    enterChase();
    return;
  }
  if (phase === "PAUSED") return; // 一時停止中は何もしない

  switch (phase) {
    case "CHASE":
      updateChase();
      break;
    case "RESCUE":
      updateRescue();
      break;
    case "REGROUP":
      updateRegroup();
      break;
    case "HELP_NEEDED":
      updateHelpNeeded();
      break;
  }
}

// ==== 効果音 ====
function playSound(cube, seId) {
  // playSE未対応のp5.toioバージョンでも落ちないようにガードする
  if (typeof cube.playSE === "function") cube.playSE(seId);
}

// ==== phase: CHASE ====
function enterChase() {
  phase = "CHASE";
  catchSince = null;
  rescue = null;
  resetStuckDetection();
  setRoleLights(); // 役割LEDを付け直す（鬼=red / 逃げ=blue）
}

function resetStuckDetection() {
  // REGROUPの待機・一時停止など「止まっていて当然」の区間を抜けた直後は、
  // その停止時間がスタック判定に持ち越されて即救助に入ってしまうため基準を取り直す
  const now = millis();
  states.forEach((st) => {
    st.stillAnchor = null;
    st.lastMoveAt = now;
  });
}

function setRoleLights() {
  cubes[chaserIdx].turnLightOn("red");
  cubes[runnerIdx].turnLightOn("blue");
}

function updateChase() {
  const now = millis();
  const chaserCube = cubes[chaserIdx];
  const runnerCube = cubes[runnerIdx];
  const chaserSt = states[chaserIdx];
  const runnerSt = states[runnerIdx];

  // トラブル検知はCHASE中のみ行う。REGROUP/RESCUE/PAUSED中は意図的な停止があるため誤検知を防ぐ
  const trouble = findTroubleIdx();
  if (trouble !== null) {
    enterRescue(trouble.kind, trouble.idx);
    return;
  }

  // 鬼の追跡: 現在位置をそのまま追うと常に後追いになるため、速度から先読みした位置を狙う
  if (
    chaserSt.pos !== null &&
    runnerSt.pos !== null &&
    now - chaserSt.lastCmdAt > MOVE_INTERVAL
  ) {
    const aim = clampToSafe(vAdd(runnerSt.pos, vScale(runnerSt.velocity, LEAD_TIME)));
    chaserCube.moveTo(aim, SPEED);
    chaserSt.lastCmdAt = now;
  }

  // 逃げの回避: 鬼からの反発と壁からの反発を合成して逃走方向を決める
  if (
    runnerSt.pos !== null &&
    chaserSt.pos !== null &&
    now - runnerSt.lastCmdAt > MOVE_INTERVAL
  ) {
    const away = vNorm(vSub(runnerSt.pos, chaserSt.pos));
    const wall = wallRepulsion(runnerSt.pos);
    let dir = vNorm(vAdd(vScale(away, W_AWAY), vScale(wall, W_WALL)));
    if (vLen(dir) === 0) dir = away; // 合成がゼロベクトルになったらawayで代用する
    const aim = clampToSafe(vAdd(runnerSt.pos, vScale(dir, STEP)));
    runnerCube.moveTo(aim, SPEED);
    runnerSt.lastCmdAt = now;
  }

  // 捕獲判定: 両機の座標が読めていてCATCH_DIST未満の状態がCATCH_HOLD_MS継続したら成立
  if (
    chaserSt.pos !== null &&
    runnerSt.pos !== null &&
    vDist(chaserSt.pos, runnerSt.pos) < CATCH_DIST
  ) {
    if (catchSince === null) catchSince = now;
    if (now - catchSince > CATCH_HOLD_MS) {
      // 役割交代（救助はペナルティではないため役割交代は捕獲時のみ）
      const tmp = chaserIdx;
      chaserIdx = runnerIdx;
      runnerIdx = tmp;
      catchSince = null;
      playSound(chaserCube, SE_CATCH);
      enterRegroup();
    }
  } else {
    catchSince = null;
  }
}

function wallRepulsion(p) {
  // 安全域の境界に近いほど強く内向きに働くベクトルを返す
  const minX = MAT.minX + SAFE_MARGIN;
  const maxX = MAT.maxX - SAFE_MARGIN;
  const minY = MAT.minY + SAFE_MARGIN;
  const maxY = MAT.maxY - SAFE_MARGIN;
  let vx = 0;
  let vy = 0;

  const distLeft = p.x - minX;
  if (distLeft < WALL_RANGE) vx += (WALL_RANGE - distLeft) / WALL_RANGE;
  const distRight = maxX - p.x;
  if (distRight < WALL_RANGE) vx -= (WALL_RANGE - distRight) / WALL_RANGE;
  const distTop = p.y - minY;
  if (distTop < WALL_RANGE) vy += (WALL_RANGE - distTop) / WALL_RANGE;
  const distBottom = maxY - p.y;
  if (distBottom < WALL_RANGE) vy -= (WALL_RANGE - distBottom) / WALL_RANGE;

  return { x: vx, y: vy };
}

function clampToSafe(p) {
  // マット内側の安全マージンに座標を丸める
  return {
    x: constrain(p.x, MAT.minX + SAFE_MARGIN, MAT.maxX - SAFE_MARGIN),
    y: constrain(p.y, MAT.minY + SAFE_MARGIN, MAT.maxY - SAFE_MARGIN),
  };
}

function findTroubleIdx() {
  // OFF_MAT: 座標ロストがLOST_MSを超えて継続
  // STUCK_ON_MAT: マット内で座標は読めているが移動が無い状態がSTUCK_MSを超えて継続
  const now = millis();
  for (const idx of [chaserIdx, runnerIdx]) {
    const st = states[idx];
    if (st.lostSince !== null && now - st.lostSince > LOST_MS) {
      return { kind: "OFF_MAT", idx };
    }
    if (st.pos !== null && now - st.lastMoveAt > STUCK_MS) {
      return { kind: "STUCK_ON_MAT", idx };
    }
  }
  return null;
}

// ==== phase: RESCUE ====
function enterRescue(kind, targetIdx) {
  phase = "RESCUE";
  const helperIdx = targetIdx === chaserIdx ? runnerIdx : chaserIdx;
  rescue = {
    kind, // "OFF_MAT" | "STUCK_ON_MAT"
    targetIdx,
    helperIdx,
    startedAt: millis(),
    retries: 0,
    step: "APPROACH", // STUCK_ON_MATのみ使用: "APPROACH" | "ACT" | "BUMP"
    nextActAt: 0,
  };
  // 両機のLEDを緑にする（遷移時に1回だけ）
  cubes[targetIdx].turnLightOn("green");
  cubes[helperIdx].turnLightOn("green");
}

function updateRescue() {
  if (rescue.kind === "OFF_MAT") updateRescueOffMat();
  else updateRescueStuck();
}

function updateRescueOffMat() {
  // 重要な前提: moveTo()はPosition IDに依存するためロスト中は使えない。
  // moveTo以外で座標なしでも送れるmove()（時間指定モーター制御）で後退させる。
  const now = millis();
  const target = states[rescue.targetIdx];
  const helper = states[rescue.helperIdx];
  const helperCube = cubes[rescue.helperIdx];
  const targetCube = cubes[rescue.targetIdx];

  // 座標が復帰したら成功。helperの方を向かせてREGROUPへ
  if (target.pos !== null) {
    // 救助中にhelper自身がロストしている可能性があるため、座標が読めるときだけ向きを合わせる
    if (helper.pos !== null) {
      targetCube.turnToXY(helper.pos.x, helper.pos.y, RESCUE_SPEED);
    }
    playSound(targetCube, SE_RESCUE);
    enterRegroup();
    return;
  }

  // 打ち切り判定は後退を送る前に置く。送った直後に判定すると、
  // 上限回目の後退が効いたかどうかを見ないままHELP_NEEDEDへ落ちてしまう
  if (rescue.retries >= RETRY_MAX || now - rescue.startedAt > RESCUE_TIMEOUT) {
    enterHelpNeeded();
    return;
  }

  // helperはロスト地点に一番近い安全域内の点へ向かう。合流点であり誘導の目印になる
  if (now - helper.lastCmdAt > MOVE_INTERVAL && target.lastValidPos !== null) {
    helperCube.moveTo(clampToSafe(target.lastValidPos), RESCUE_SPEED);
    helper.lastCmdAt = now;
  }

  // 最後の進行方向(lastHeading)の逆向きへ後退させる。送るたびリトライ回数を進め、次の実行時刻を延ばす
  if (now >= rescue.nextActAt) {
    targetCube.move(-RESCUE_SPEED, -RESCUE_SPEED, BACK_MS + rescue.retries * 200);
    rescue.retries++;
    rescue.nextActAt = now + BACK_MS + rescue.retries * 200 + 400;
  }
}

function updateRescueStuck() {
  // 救助側が横から押し、本人は後退する。押す向きと後退向きを直交させることで
  // 互いを打ち消さず、かつ本人を障害物へ押し付けないようにする。
  const now = millis();
  const target = states[rescue.targetIdx];
  const helper = states[rescue.helperIdx];
  const helperCube = cubes[rescue.helperIdx];
  const targetCube = cubes[rescue.targetIdx];

  // 救助を始めてからtargetがSTUCK_EPS以上動いていれば脱出成功
  if (target.pos !== null && target.lastMoveAt > rescue.startedAt) {
    playSound(targetCube, SE_RESCUE);
    enterRegroup();
    return;
  }

  // 打ち切り判定は押し出しを送る前に置く。送った直後に判定すると、
  // 上限回目の押し出しが効いたかどうかを見ないままHELP_NEEDEDへ落ちてしまう
  if (rescue.retries >= RETRY_MAX || now - rescue.startedAt > RESCUE_TIMEOUT) {
    enterHelpNeeded();
    return;
  }

  if (rescue.step === "APPROACH") {
    if (target.pos !== null) {
      const perp = pickApproachPerp(target);
      const approachPoint = clampToSafe(vAdd(target.pos, vScale(perp, APPROACH_DIST)));
      if (now - helper.lastCmdAt > MOVE_INTERVAL) {
        helperCube.moveTo(approachPoint, RESCUE_SPEED);
        helper.lastCmdAt = now;
      }
      // 到着判定はtargetとの距離ではなく接近地点との距離で見る。
      // 接近地点はtargetからAPPROACH_DIST(60)離れた位置にあるため、
      // target基準ではARRIVE_DIST(25)以内に入れず、永久にACTへ進めない
      if (helper.pos !== null && vDist(helper.pos, approachPoint) <= ARRIVE_DIST) {
        rescue.step = "ACT";
        rescue.nextActAt = now;
      }
    }
  } else if (rescue.step === "ACT") {
    if (now >= rescue.nextActAt && target.pos !== null) {
      helperCube.turnToXY(target.pos.x, target.pos.y, RESCUE_SPEED);
      rescue.nextActAt = now + 800;
      rescue.step = "BUMP";
    }
  } else if (rescue.step === "BUMP") {
    if (now >= rescue.nextActAt) {
      helperCube.move(RESCUE_SPEED, RESCUE_SPEED, BUMP_MS); // 横から押す
      targetCube.move(-RESCUE_SPEED, -RESCUE_SPEED, BACK_MS); // 同時に後退
      rescue.retries++;
      rescue.step = "APPROACH";
      rescue.nextActAt = now + BACK_MS + 600;
    }
  }
}

function pickApproachPerp(target) {
  // lastHeadingを90°回転させた2候補のうち、マット中心に近づく方を選ぶ
  // （lastHeadingが無ければマット中心へ向かうベクトルで代用する）
  if (target.lastHeading === null) {
    return vNorm(vSub({ x: MAT.centerX, y: MAT.centerY }, target.pos));
  }
  const h = target.lastHeading;
  const perpA = { x: -h.y, y: h.x };
  const perpB = { x: h.y, y: -h.x };
  const center = { x: MAT.centerX, y: MAT.centerY };
  const candA = vAdd(target.pos, vScale(perpA, APPROACH_DIST));
  const candB = vAdd(target.pos, vScale(perpB, APPROACH_DIST));
  return vDist(candA, center) <= vDist(candB, center) ? perpA : perpB;
}

// ==== phase: REGROUP ====
function enterRegroup() {
  phase = "REGROUP";
  rescue = null;
  regroupUntil = millis() + REGROUP_WAIT;
  cubes.forEach((cube) => cube.turnLightOn("white"));
}

function updateRegroup() {
  // 鬼と逃げをマット中心を挟んだ定位置へ離す。役割交代は捕獲時のみなので、ここでは入れ替えない
  const now = millis();
  const chaserCube = cubes[chaserIdx];
  const runnerCube = cubes[runnerIdx];
  const chaserSt = states[chaserIdx];
  const runnerSt = states[runnerIdx];

  if (chaserSt.pos !== null && now - chaserSt.lastCmdAt > MOVE_INTERVAL) {
    chaserCube.moveTo({ x: MAT.centerX - 80, y: MAT.centerY }, SPEED);
    chaserSt.lastCmdAt = now;
  }
  if (runnerSt.pos !== null && now - runnerSt.lastCmdAt > MOVE_INTERVAL) {
    runnerCube.moveTo({ x: MAT.centerX + 80, y: MAT.centerY }, SPEED);
    runnerSt.lastCmdAt = now;
  }

  if (now > regroupUntil) enterChase(); // CHASE遷移時にLEDが役割色(赤/青)へ戻る
}

// ==== phase: HELP_NEEDED ====
function enterHelpNeeded() {
  phase = "HELP_NEEDED";
  lastBlinkAt = millis();
  blinkOn = false;
  // helperのLEDは緑のまま維持し、rescueコンテキストもクリアしない（復帰判定に使い続けるため）
}

function updateHelpNeeded() {
  const now = millis();
  const target = states[rescue.targetIdx];
  const targetCube = cubes[rescue.targetIdx];

  // トラブル機のLEDを500ms周期で黄色に点滅させる
  if (now - lastBlinkAt > 500) {
    blinkOn = !blinkOn;
    lastBlinkAt = now;
    if (blinkOn) targetCube.turnLightOn("yellow");
    else targetCube.turnLightOff();
  }

  // 座標が復帰し、かつ救助開始後に動いた（＝人が戻した／自力で抜けた）らREGROUPへ
  if (target.pos !== null && target.lastMoveAt > rescue.startedAt) {
    enterRegroup();
  }
}

// ==== 描画 ====
function drawMat() {
  // マット外形の表示（sample.jsの描画パターンを踏襲）
  fill("white");
  stroke(150);
  strokeWeight(1);
  rect(MAT_X, MAT_Y, MAT_W, MAT_H);
  stroke(COLOR_MAIN);
  strokeWeight(1);

  // SimpleTileMatはマス目の線を引く
  for (let i = 1; i < 7; i++) {
    const x = MAT_X + (MAT_W / 7) * i;
    line(x, MAT_Y, x, MAT_Y + MAT_H);
  }
  for (let j = 1; j < 5; j++) {
    const y = MAT_Y + (MAT_H / 5) * j;
    line(MAT_X, y, MAT_X + MAT_W, y);
  }

  noStroke();
  fill(COLOR_MAIN);
  circle(MAT_W / 2 + MAT_X, MAT_H / 2 + MAT_Y, 3);
}

function drawWaitingMessage() {
  fill(100);
  noStroke();
  textSize(20);
  textAlign(CENTER, CENTER);
  text("c キー / ボタンで接続してください（2台必要）", BASE_W / 2, BASE_H / 6);
}

function drawCubes() {
  // キューブの位置表示。cube座標→画面座標のmap()はMAT定数から算出する（マットを変えても破綻しないように）
  for (let i = 0; i < cubes.length; i++) {
    const cube = cubes[i];
    if (typeof cube.x !== "number" || typeof cube.y !== "number") continue;

    const displayX = map(cube.x, MAT.minX, MAT.maxX, MAT_X, MAT_X + MAT_W);
    const displayY = map(cube.y, MAT.minY, MAT.maxY, MAT_Y, MAT_Y + MAT_H);
    const cubeSize = 36;

    // 役割・トラブル状態で枠を色分けする（鬼=赤枠、逃げ=青枠、トラブル中=太い黄枠）
    const isTrouble = rescue !== null && rescue.targetIdx === i;
    let strokeColor = color(0);
    let strokeW = 2;
    if (isTrouble) {
      strokeColor = color(230, 190, 0);
      strokeW = 5;
    } else if (i === chaserIdx) {
      strokeColor = color(220, 40, 40);
    } else if (i === runnerIdx) {
      strokeColor = color(40, 90, 220);
    }

    push();
    translate(displayX, displayY);
    if (typeof cube.angle === "number") rotate(cube.angle);

    rectMode(CENTER);
    stroke(strokeColor);
    strokeWeight(strokeW);
    fill("white");
    rect(0, 0, cubeSize, cubeSize, 1);
    fill(COLOR_MAIN);
    noStroke();
    rect(cubeSize / 3, 0, cubeSize / 4, cubeSize / 4);

    if (typeof cube.angle === "number") rotate(-cube.angle);
    fill("black");
    textAlign(CENTER, CENTER);
    textSize(10);
    text(i + 1, 0, 0);
    pop();
  }
}

function drawHud() {
  // 画面左上にゲーム状態を表示する。デモ中に状態が読み取れることを重視する
  push();
  const x = 20;
  let y = 70;
  const lineH = 18;
  noStroke();
  textAlign(LEFT, TOP);
  textSize(14);

  fill(20);
  text(`phase: ${phase}`, x, y);
  y += lineH;

  if (phase === "HELP_NEEDED") {
    fill(200, 120, 0);
    text("手でマットに戻してください", x, y);
    y += lineH;
    fill(20);
  }

  if (cubes.length < 2) {
    text("c キー / ボタンで接続（2台必要）", x, y);
    y += lineH;
  } else {
    text(`鬼: Cube${chaserIdx + 1} / 逃げ: Cube${runnerIdx + 1}`, x, y);
    y += lineH;

    const chaserSt = states[chaserIdx];
    const runnerSt = states[runnerIdx];
    const distText =
      chaserSt.pos !== null && runnerSt.pos !== null
        ? nf(vDist(chaserSt.pos, runnerSt.pos), 1, 1)
        : "---";
    text(`2機間の距離: ${distText}`, x, y);
    y += lineH;

    const now = millis();
    for (let i = 0; i < cubes.length; i++) {
      const st = states[i];
      // 静止時間も出す（STUCK_MSの調整に使うため）
      const posText =
        st.pos !== null
          ? `(${nf(st.pos.x, 1, 0)}, ${nf(st.pos.y, 1, 0)}) 静止 ${nf((now - st.lastMoveAt) / 1000, 1, 1)}s`
          : `LOST (${nf((now - st.lostSince) / 1000, 1, 1)}s)`;
      text(`Cube${i + 1}: ${posText}`, x, y);
      y += lineH;
    }

    if (rescue !== null) {
      text(`救助リトライ: ${rescue.retries}/${RETRY_MAX}`, x, y);
      y += lineH;
    }
  }

  y += 6;
  text("[c]接続 [r]仕切り直し [f]全画面 [space]一時停止", x, y);
  pop();
}
