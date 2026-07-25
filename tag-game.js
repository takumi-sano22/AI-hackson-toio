/* toio 2台の鬼ごっこ＋救助・勝利ダンス・仕切り直し
   Thanks to p5.toio https://tetunori.github.io/p5.toio/

   p5.js Web Editor にそのままコピペできるよう、ゲームロジックはこの1ファイルで完結させる。
   （Web Editor で動かす場合は index.html に p5.toio の script タグを1行足すだけでよい）
*/

// ==== マット・ゲームパラメータ定数 ====
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
const LEAD_TIME = 0.35; // 鬼の先読み秒数
const CATCH_DIST = 35; // 捕獲判定距離。車体幅(約32)とほぼ同じ＝ほぼ完全に接触したときだけ成立させる
const CATCH_HOLD_MS = 300; // 捕獲成立に必要な継続時間
const LOST_MS = 800; // 座標ロスト判定時間
// 障害物に押し付けられて空転していると、座標ノイズや微小な首振りだけで5程度は「動いて」しまい、
// スタックと判定されず救助が発動しなかった。正常走行なら1.5秒で15を大きく超えるため閾値を上げる
const STUCK_EPS = 15; // これ未満の移動量は「動いていない」とみなす
const STUCK_MS = 1500; // マット内スタック判定時間（低速化で1コマンドあたりの移動が遅くなるため緩めた）
const BACK_MS = 600; // 後退の基本時間
const RETRY_MAX = 6; // 救助リトライ上限（BUMPED=横押しの回数 / OFF_MAT=後退の回数）
const RESCUE_TIMEOUT = 15000; // 救助断念までの時間
const RESCUE_PRELUDE_MS = 1600; // 救助開始前の予告演出の長さ（音楽を鳴らし終えてから動き出す）
// 「なにかにぶつかって速度が想定より変わった」の判定
const BUMP_WINDOW_MIN_MS = 250; // 衝突直後は平滑化した速度がまだ落ちきっていないため、判定を少し待つ
const BUMP_WINDOW_MAX_MS = 900; // 衝突からこの時間内に減速が確認できたら「ぶつかって止まった」とみなす
const BUMP_SLOW_SPEED = 15; // これ未満の実測速度（座標/秒）を「想定より遅い」とみなす
const BUMP_SLOW_MS = 500; // 走れていた機の速度が落ちたままこの時間続いたら、衝突イベントが無くても救助へ
const BUMP_IGNORE_GAP = 70; // 2台がこの距離以内での衝突はお互いの接触（捕獲判定に任せる）なので無視
const REGROUP_HOLD_MS = 3000; // 全機がスタート地点に揃ってから再スタートまでの待機時間
const REGROUP_TIMEOUT = 12000; // 定位置に戻れなくてもデモを止めないための打ち切り時間（待機ぶん延長）
const HOME_ARRIVE_DIST = 30; // スタート地点に戻ったとみなす距離

// 速度（有効値域は 8..115。0 と ±8..115 以外は無効）
const SPEED = 35; // 通常速度。挙動を目で追える速さを優先して低めにしている
const NEAR_SPEED = 20; // 接近中の鬼の速度。全速のまま突っ込ませない
const RESCUE_SPEED = 25; // 救助時の低速
const PUSH_SPEED = 50; // 押し出し瞬間の速度（RESCUE_SPEEDのままだと押し負けて動かせないことがある）
// 押せていない（リトライが進む）ときに押す角度を変える順番。
// 真横 → 斜め2方向 → 反対の真横 → 反対の斜め2方向、と当たり方を変えて引っかかりを外す
const PUSH_ANGLE_STEPS = [0, 35, -35, 180, 145, -145];
const RETREAT_MS = 500; // 押したあと一旦離れる後退時間（次の角度へ回り込みやすくする）
const NEAR_DIST = 90; // これ以内を「接近中」とみなす（鬼は減速・逃げは横へ回り込む）

const BUMP_MS = 400; // 押し出し時間
const MOVE_INTERVAL = 200; // BLE コマンドの最短送信間隔（毎フレーム送ると詰まるため間引く）
const STEP = 70; // 逃走時の目標点までの距離
const W_AWAY = 1.0; // 鬼からの反発重み
const W_SIDE = 1.2; // 横へ回り込む重み（正面衝突回避用）
const W_WALL = 2.0; // 壁からの反発重み（壁際で袋小路に入ると正面衝突しやすいので強め）
const APPROACH_DIST = 60; // 救助時に横へ回り込む距離
const ARRIVE_DIST = 25; // 接近完了とみなす距離
const VEL_EPS = 1; // これ未満の速度では進行方向を更新しない
const VEL_SMOOTH = 0.3; // 速度の指数移動平均係数（座標ノイズで先読み点が暴れるのを抑える）

// ==== LED（色文字列の解釈がバージョン依存になりうるため RGB で直接指定する） ====
const LED_CHASER = [255, 0, 0]; // 鬼
const LED_RUNNER = [0, 80, 255]; // 逃げ
const LED_HOME = [255, 255, 255]; // 仕切り直し（スタート地点へ移動中）
const LED_RESCUER = [0, 255, 80]; // 救助している側
const LED_TARGET = [255, 170, 0]; // 救助されている側
const LED_HELP = [255, 0, 150]; // 人の助けが必要（救助中の色と区別する）
const RESCUE_BLINK_MS = 300; // 救助中の点滅周期。「作業中」に見えるよう速めにする
const HELP_BLINK_MS = 500; // 人待ち中の点滅周期

// ==== 勝利ダンス ====
const DANCE_MS = 3200; // 踊る時間
const DANCE_STEP_MS = 350; // 回転の向き・色を切り替える間隔
const DANCE_SPEED = 45; // 勝者のスピン速度
const DANCE_COLORS = [
  [255, 0, 0],
  [255, 180, 0],
  [0, 255, 80],
  [0, 180, 255],
  [200, 0, 255],
];

// ==== 効果音 ====
// P5tCube.seId 相当。未対応バージョンでも落ちないよう playSound()/playMelody() 側でガードする
const SE_RESCUE = 10; // effect2 相当（救助成功時）
const SE_HIT = 2; // cancel 相当（衝突検知時）
const RESCUE_POP_MS = 2500; // 救助中の合図を鳴らし直す周期（間隔を空けて騒がしさを抑える）
const HELP_CALL_MS = 3000; // 人待ち中の呼び出し音の周期
// 救助中のポップな合図（ド→ミ→ソのスタッカート）。duration の単位は 10ms（toio 仕様。255でクリップ）。
// p5.toio の playMelody は音量が 255 固定で実音量は下げられないため、
// サイレン風の高く長い連続音をやめ、中音域の短い音＋休符で「音量を下げたように」柔らかく聞こえさせる
const RESCUE_POP_MELODY = [
  { note: 72, duration: 10 },
  { note: 128, duration: 8 }, // note 128 は休符
  { note: 76, duration: 10 },
  { note: 128, duration: 8 },
  { note: 79, duration: 14 },
];
// 人を呼ぶ音。note 128 は無音（休符）
const HELP_MELODY = [
  { note: 88, duration: 200 },
  { note: 128, duration: 150 },
  { note: 88, duration: 200 },
];
// 救助開始の予告ジングル（出動ラッパ風）。鳴らし終えるまで動かず「今から救助する」ことを観客に予告する
const RESCUE_START_MELODY = [
  { note: 67, duration: 200 },
  { note: 72, duration: 200 },
  { note: 76, duration: 250 },
  { note: 79, duration: 450 },
];
// 勝利ファンファーレ（ド→ミ→ソ→高いド）
const WIN_MELODY = [
  { note: 72, duration: 150 },
  { note: 76, duration: 150 },
  { note: 79, duration: 150 },
  { note: 84, duration: 400 },
];

// マット描画レイアウト（cube座標→画面座標のmap()にはMAT定数を使う）
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
// "WAITING"（接続待ち） | "READY"（接続済み・スタート待ち） | "CHASE" | "CELEBRATE"
// | "RESCUE" | "REGROUP" | "HELP_NEEDED" | "PAUSED"
let phase = "WAITING";
let chaserIdx = 0;
let runnerIdx = 1;

let connectBtn; // 接続ボタン
let startBtn; // ゲームスタートボタン
let fsBtn; // 全画面表示ボタン

let catchSince = null; // CHASE中、捕獲距離内に入り続けている開始時刻
let rescue = null; // RESCUE/HELP_NEEDED中の救助コンテキスト
let celebrate = null; // CELEBRATE中の勝利ダンスのコンテキスト
let regroupStartedAt = 0; // REGROUPに入った時刻
let regroupArrivedAt = null; // 全機がスタート地点に揃った時刻。ここから数秒待って再スタートする
let pausedFromPhase = null; // PAUSEDに入る直前のphase（スペースキーで復帰するため）
let pausedAt = 0; // PAUSEDに入った時刻（復帰時に各期限を停止時間ぶん後ろへずらす）
let blinkOn = false; // LED点滅の状態
let lastBlinkAt = 0; // 直前の点滅切り替え時刻
let lastSoundAt = 0; // 直前にサイレン／呼び出し音を鳴らした時刻

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
function vRotate(v, rad) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

// ==== CubeState 生成 ====
function makeCubeState() {
  return {
    pos: null, // 現在の有効座標。ロスト中はnull
    prevPos: null,
    velocity: { x: 0, y: 0 }, // 座標単位/秒
    lastValidPos: null, // 最後に読めた座標
    lastHeading: null, // 最後の進行方向（正規化済み）。救助時の後退方向・押す向きの推定に使う
    homePos: null, // 起動地点。仕切り直しでは必ずここへ戻る
    lostSince: null, // 座標を失った時刻(millis)
    stillAnchor: null, // スタック判定の基準座標（ここからSTUCK_EPS以上離れたら「動いた」）
    lastMoveAt: 0, // 最後に基準座標からSTUCK_EPS以上離れた時刻(millis)
    lastCmdAt: 0, // 最後にBLEコマンドを送った時刻
    lastCollisionAt: -10000, // 直近の衝突イベント時刻（「ぶつかって止まった」判定に使う）
    slowSince: null, // 実測速度がBUMP_SLOW_SPEED未満に落ちた時刻
    wasRunning: false, // 一度でも走れて（十分な速度が出て）いたか。停止明けの誤検知を防ぐ
  };
}

// ==== p5 ライフサイクル ====
function setup() {
  // 初期設定
  createCanvas(windowWidth, windowHeight);
  connectBtn = createButton("toioを接続する（2台必要）");
  connectBtn.position(20, 20);
  connectBtn.mousePressed(connectToio);
  // 接続した瞬間に走り出すと toio を置く時間がないため、開始は明示的にボタンで行う
  startBtn = createButton("ゲームスタート");
  startBtn.position(200, 20);
  startBtn.mousePressed(startGame);
  startBtn.attribute("disabled", ""); // 2台そろうまでは押せない
  fsBtn = createButton("全画面表示");
  fsBtn.position(320, 20);
  fsBtn.mousePressed(toggleFullscreen);
}

function startGame() {
  if (cubes.length < 2) return;
  // 押した時点の位置をスタート地点として記録し直す。
  // 置き終わってから押してもらう前提なので、ここが「起動地点」になる
  states.forEach((st) => {
    st.homePos = st.pos;
  });
  startBtn.html("リスタート");
  enterChase();
}

function connectToio() {
  // toioのキューブとの接続（Web Bluetoothの制約でユーザー操作イベント内からのみ呼べる）
  P5tCube.connectNewP5tCube().then((cube) => {
    const idx = cubes.length; // このキューブの通し番号。イベントハンドラから参照する
    cubes.push(cube);
    states.push(makeCubeState());
    setLight(cube, LED_HOME);
    connectBtn.html(cubes.length < 2 ? "次のtoioを接続" : "接続済み（2台）");

    // 衝突はプロパティで取れずイベントでしか拾えない。
    // 「ぶつかって止まった」(BUMPED)判定に使うため、発生時刻を記録する
    cube.addEventListener("sensorcollision", () => {
      playSound(cube, SE_HIT);
      states[idx].lastCollisionAt = millis();
    });

    // 2台そろってもすぐには始めない。配置を終えてスタートを押すまでREADYで待つ
    if (cubes.length >= 2 && phase === "WAITING") {
      phase = "READY";
      startBtn.removeAttribute("disabled");
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
  if (key === "s" || key === "S") startGame();
  if (key === "r" || key === "R") {
    // 強制的に仕切り直しへ戻す（HELP_NEEDEDからの手動復帰も兼ねる）。
    // スタート前は戻る先が未確定なので受け付けない
    if (cubes.length >= 2 && phase !== "READY") enterRegroup();
  }
  if (key === " " && phase !== "READY") togglePause();
}

function togglePause() {
  if (phase === "PAUSED") {
    // 直前のphaseへ復帰。停止していた時間ぶん各期限を後ろへずらす。
    // ずらさないと、長く止めただけで救助タイムアウトや捕獲が勝手に成立してしまう
    const pausedMs = millis() - pausedAt;
    if (rescue !== null) {
      rescue.startedAt += pausedMs;
      rescue.nextActAt += pausedMs;
      rescue.preludeUntil += pausedMs;
    }
    if (celebrate !== null) {
      celebrate.startedAt += pausedMs;
      celebrate.nextStepAt += pausedMs;
    }
    regroupStartedAt += pausedMs;
    if (regroupArrivedAt !== null) regroupArrivedAt += pausedMs;
    if (catchSince !== null) catchSince += pausedMs;

    phase = pausedFromPhase || "CHASE";
    pausedFromPhase = null;
    resetStuckDetection(); // 停止していた時間をスタック判定に持ち越さない
  } else {
    pausedFromPhase = phase;
    pausedAt = millis();
    phase = "PAUSED";
    // 毎フレーム送ると詰まるため、停止コマンドは1回だけ送る。
    // 点滅の消灯タイミングで止まると故障に見えるため、LEDは白で点け直す
    cubes.forEach((cube) => {
      cube.move(0, 0, 100);
      setLight(cube, LED_HOME);
    });
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
  drawHomes();
  if (cubes.length < 2) {
    drawWaitingMessage("c キー / ボタンで接続してください（2台必要）");
  } else {
    // READY中もキューブは描画する。置いた位置を画面で確かめてからスタートできるようにする
    if (phase === "READY") {
      drawWaitingMessage("toio を置いたら [ゲームスタート] を押してください");
    }
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
      // 鬼の先読み・救助時の後退方向・押す向きの推定に使うため、
      // ある程度動いているときだけ進行方向を更新する
      if (vLen(st.velocity) > VEL_EPS) {
        st.lastHeading = vNorm(st.velocity);
      }

      // 「走れていたのに遅くなった」の検知用。閾値ちょうどで判定が往復しないよう、
      // 「走れている」認定は少し高い速度(1.5倍)で行う
      const spd = vLen(st.velocity);
      if (spd >= BUMP_SLOW_SPEED) {
        st.slowSince = null;
        if (spd > BUMP_SLOW_SPEED * 1.5) st.wasRunning = true;
      } else if (st.slowSince === null) {
        st.slowSince = now;
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
      st.slowSince = null; // ロスト中は速度が更新されないため減速判定を止める
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
    // 通常はconnectToio()内で遷移済みだが、念のためここでもREADYへ上げる
    phase = "READY";
    startBtn.removeAttribute("disabled");
    return;
  }
  if (phase === "READY") return; // スタートボタン待ち。toioは動かさない
  if (phase === "PAUSED") return; // 一時停止中は何もしない

  switch (phase) {
    case "CHASE":
      updateChase();
      break;
    case "CELEBRATE":
      updateCelebrate();
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

// ==== LED・効果音 ====
function setLight(cube, rgb) {
  // turnLightOnRGB を持たないバージョンでもデモが止まらないよう、色オブジェクト版へ退避する
  if (typeof cube.turnLightOnRGB === "function") {
    cube.turnLightOnRGB(rgb[0], rgb[1], rgb[2]);
  } else {
    cube.turnLightOn(color(rgb[0], rgb[1], rgb[2]));
  }
}

function playSound(cube, seId) {
  // playSE未対応のp5.toioバージョンでも落ちないようにガードする
  if (typeof cube.playSE === "function") cube.playSE(seId);
}

function playMelody(cube, melody) {
  // playMelody未対応のp5.toioバージョンでも落ちないようにガードする
  if (typeof cube.playMelody === "function") cube.playMelody(melody);
}

// ==== phase: CHASE ====
function enterChase() {
  phase = "CHASE";
  catchSince = null;
  rescue = null;
  celebrate = null;
  resetStuckDetection();
  setRoleLights(); // 役割LEDを付け直す（鬼=赤 / 逃げ=青）
}

function resetStuckDetection() {
  // REGROUPの待機・一時停止など「止まっていて当然」の区間を抜けた直後は、
  // その停止時間がスタック判定に持ち越されて即救助に入ってしまうため基準を取り直す
  const now = millis();
  states.forEach((st) => {
    st.stillAnchor = null;
    st.lastMoveAt = now;
    // 意図的に止まっていた区間の低速を持ち越さない。走り出しの遅さも誤検知しないよう、
    // 再び十分な速度が出るまで減速検知(BUMPED)は武装解除しておく
    st.slowSince = null;
    st.wasRunning = false;
  });
}

function setRoleLights() {
  setLight(cubes[chaserIdx], LED_CHASER);
  setLight(cubes[runnerIdx], LED_RUNNER);
}

function updateChase() {
  const now = millis();
  const chaserCube = cubes[chaserIdx];
  const runnerCube = cubes[runnerIdx];
  const chaserSt = states[chaserIdx];
  const runnerSt = states[runnerIdx];

  // RESCUE/PAUSED中は意図的な停止があるため検知しない。REGROUPでは帰還中の機に限って検知する
  const trouble = findTroubleIdx([chaserIdx, runnerIdx]);
  if (trouble !== null) {
    enterRescue(trouble.kind, trouble.idx);
    return;
  }

  const gap =
    chaserSt.pos !== null && runnerSt.pos !== null
      ? vDist(chaserSt.pos, runnerSt.pos)
      : null;

  // 鬼の追跡: 現在位置をそのまま追うと常に後追いになるため、速度から先読みした位置を狙う
  if (gap !== null && now - chaserSt.lastCmdAt > MOVE_INTERVAL) {
    const lead = vAdd(runnerSt.pos, vScale(runnerSt.velocity, LEAD_TIME));
    // 近距離では減速する。全速のまま突っ込むと正面衝突して2台が固まり、
    // 何が起きているのか見て分からなくなる
    const speed = gap < NEAR_DIST ? NEAR_SPEED : SPEED;
    chaserCube.moveTo(clampToSafe(lead), speed);
    chaserSt.lastCmdAt = now;
  }

  // 逃げの回避: 鬼からの反発・横への回り込み・壁反発を合成して逃走方向を決める
  if (gap !== null && now - runnerSt.lastCmdAt > MOVE_INTERVAL) {
    const away = vNorm(vSub(runnerSt.pos, chaserSt.pos));
    // 真後ろへ逃げるだけだと鬼と一直線に並び、追いつかれた瞬間に正面から押し合いになる。
    // 近いときほど強く横へ回り込ませて、すれ違う形に持っていく
    const sideGain = gap < NEAR_DIST ? (NEAR_DIST - gap) / NEAR_DIST : 0;
    const side = vScale(pickSideDir(away, runnerSt.pos), sideGain);
    const wall = wallRepulsion(runnerSt.pos);
    let dir = vNorm(
      vAdd(vAdd(vScale(away, W_AWAY), vScale(side, W_SIDE)), vScale(wall, W_WALL))
    );
    if (vLen(dir) === 0) dir = away; // 合成がゼロベクトルになったらawayで代用する
    const aim = clampToSafe(vAdd(runnerSt.pos, vScale(dir, STEP)));
    runnerCube.moveTo(aim, SPEED);
    runnerSt.lastCmdAt = now;
  }

  // 捕獲判定: 両機の座標が読めていてCATCH_DIST未満の状態がCATCH_HOLD_MS継続したら成立
  if (gap !== null && gap < CATCH_DIST) {
    if (catchSince === null) catchSince = now;
    if (now - catchSince > CATCH_HOLD_MS) {
      const winnerIdx = chaserIdx; // 捕まえた側が勝ち。役割交代の前に控えておく
      // 役割交代（救助はペナルティではないため役割交代は捕獲時のみ）
      const tmp = chaserIdx;
      chaserIdx = runnerIdx;
      runnerIdx = tmp;
      catchSince = null;
      enterCelebrate(winnerIdx);
    }
  } else {
    catchSince = null;
  }
}

function pickSideDir(away, pos) {
  // awayに直交する2方向のうち、マット中心へ寄る方を返す。
  // 壁側へ回り込むと袋小路に入り、結局その場で正面衝突してしまう
  const a = { x: -away.y, y: away.x };
  const b = { x: away.y, y: -away.x };
  const center = { x: MAT.centerX, y: MAT.centerY };
  const distA = vDist(vAdd(pos, vScale(a, STEP)), center);
  const distB = vDist(vAdd(pos, vScale(b, STEP)), center);
  return distA <= distB ? a : b;
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

function findTroubleIdx(indices) {
  // OFF_MAT: 座標ロストがLOST_MSを超えて継続
  // BUMPED: なにかにぶつかって速度が想定より落ちた／移動が無い状態がSTUCK_MSを超えて継続
  // 検知対象は呼び出し元が絞る（意図的に静止している機を誤検知しないため）
  const now = millis();
  const posA = states[chaserIdx].pos;
  const posB = states[runnerIdx].pos;
  const gap = posA !== null && posB !== null ? vDist(posA, posB) : null;

  for (const idx of indices) {
    const st = states[idx];
    if (st.lostSince !== null && now - st.lostSince > LOST_MS) {
      return { kind: "OFF_MAT", idx };
    }
    // 衝突イベントの直後に実測速度が落ちていたら「ぶつかって止まった」。
    // 2台が近接しているときの衝突はお互いの接触（捕獲のうち）なので対象外にする
    const sinceHit = now - st.lastCollisionAt;
    if (
      st.pos !== null &&
      sinceHit > BUMP_WINDOW_MIN_MS &&
      sinceHit < BUMP_WINDOW_MAX_MS &&
      vLen(st.velocity) < BUMP_SLOW_SPEED &&
      (gap === null || gap > BUMP_IGNORE_GAP)
    ) {
      return { kind: "BUMPED", idx };
    }
    // 走れていたのに速度が落ちたまま続く＝何かに引っかかっている。
    // 衝突イベントを拾えない止まり方でも、鬼が追いついて捕獲が成立する前に素早く救助へ入る
    if (
      st.pos !== null &&
      st.wasRunning &&
      st.slowSince !== null &&
      now - st.slowSince > BUMP_SLOW_MS &&
      (gap === null || gap > BUMP_IGNORE_GAP)
    ) {
      return { kind: "BUMPED", idx };
    }
    // それでも拾えない場合の最後の保険（従来のスタック検知）
    if (st.pos !== null && now - st.lastMoveAt > STUCK_MS) {
      return { kind: "BUMPED", idx };
    }
  }
  return null;
}

// ==== phase: CELEBRATE（勝利ダンス） ====
function enterCelebrate(winnerIdx) {
  phase = "CELEBRATE";
  celebrate = {
    winnerIdx,
    startedAt: millis(),
    nextStepAt: 0, // 初回はすぐ踊り出す
    spin: 1,
    colorIdx: 0,
  };
  playMelody(cubes[winnerIdx], WIN_MELODY); // 勝った側がファンファーレを鳴らす
  // 踊るのは勝った鬼側だけ。負けた側は止めて見届けさせ、どちらが勝ったか一目で分かるようにする
  cubes.forEach((cube, i) => {
    if (i !== winnerIdx) {
      cube.move(0, 0, 100);
      setLight(cube, LED_HOME);
    }
  });
}

function updateCelebrate() {
  // 勝った鬼側だけがその場で踊る（負けた側はenterCelebrateで停止させたまま見届ける）
  const now = millis();

  if (now - celebrate.startedAt > DANCE_MS) {
    enterRegroup(); // 踊り終わったらスタート地点へ戻って仕切り直す
    return;
  }

  if (now >= celebrate.nextStepAt) {
    celebrate.nextStepAt = now + DANCE_STEP_MS;
    celebrate.spin *= -1; // 左右交互に回してくねらせる
    celebrate.colorIdx = (celebrate.colorIdx + 1) % DANCE_COLORS.length;

    const winnerCube = cubes[celebrate.winnerIdx];
    // 左右モーターを逆向きに回してその場スピン。位置がほとんど動かないので
    // 踊ったあとスタート地点まで戻る距離も変わらない
    winnerCube.move(
      DANCE_SPEED * celebrate.spin,
      -DANCE_SPEED * celebrate.spin,
      DANCE_STEP_MS
    );
    setLight(winnerCube, DANCE_COLORS[celebrate.colorIdx]);
  }
}

// ==== phase: RESCUE ====
function enterRescue(kind, targetIdx) {
  phase = "RESCUE";
  const helperIdx = targetIdx === chaserIdx ? runnerIdx : chaserIdx;
  const now = millis();
  rescue = {
    kind, // "OFF_MAT" | "BUMPED"
    targetIdx,
    helperIdx,
    startedAt: now,
    preludeUntil: now + RESCUE_PRELUDE_MS, // ここまでは動かず、音楽で救助開始を予告する
    retries: 0,
    step: "APPROACH", // BUMPEDのみ使用: "APPROACH" | "ACT" | "PUSH" | "RETREAT"
    nextActAt: 0,
  };
  // 遷移直後から救助中と分かるようLEDを点ける
  blinkOn = true;
  lastBlinkAt = now;
  // 救助中の合図は予告ジングルと重ならないよう、1周期(RESCUE_POP_MS)あとから鳴らし始める
  lastSoundAt = now;
  setLight(cubes[targetIdx], LED_TARGET);
  setLight(cubes[helperIdx], LED_RESCUER);
  // 追跡中の移動コマンドを打ち切って一拍置き、「音楽 → 救助開始」の流れを見せる
  cubes.forEach((cube) => cube.move(0, 0, 100));
  playMelody(cubes[helperIdx], RESCUE_START_MELODY);
}

function updateRescue() {
  updateRescueEffects(); // 救助中であることをLEDとサイレンで示す
  // 予告演出中は動かない。音楽を鳴らし終えてから救助動作に入る
  if (millis() < rescue.preludeUntil) return;
  if (rescue.kind === "OFF_MAT") updateRescueOffMat();
  else updateRescueBumped();
}

function updateRescueEffects() {
  // 救助中の演出。BLEを詰まらせないよう、送信は周期を空けて行う
  const now = millis();
  const targetCube = cubes[rescue.targetIdx];
  const helperCube = cubes[rescue.helperIdx];

  // 救助されている側=オレンジ、救助している側=緑で点滅させ、どちらの役かを見分けられるようにする
  if (now - lastBlinkAt > RESCUE_BLINK_MS) {
    lastBlinkAt = now;
    blinkOn = !blinkOn;
    if (blinkOn) {
      setLight(targetCube, LED_TARGET);
      setLight(helperCube, LED_RESCUER);
    } else {
      targetCube.turnLightOff();
      helperCube.turnLightOff();
    }
  }

  // 救助に向かっている側からポップな合図を鳴らす（救助入りのアラートより軽い音）
  if (now - lastSoundAt > RESCUE_POP_MS) {
    lastSoundAt = now;
    playMelody(helperCube, RESCUE_POP_MELODY);
  }
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

  // 後退でマットへ戻す。まっすぐ下がるだけだと落ちた向きによっては戻れないため、
  // リトライごとに「直進 → 左寄り → 右寄り」と後退の角度を変えて、戻れる向きを探す
  if (now >= rescue.nextActAt) {
    const durMs = BACK_MS + rescue.retries * 200;
    const slow = -Math.max(8, Math.round(RESCUE_SPEED * 0.4)); // 速度の有効値域(±8..115)を下回らないようにする
    const backPattern = rescue.retries % 3;
    if (backPattern === 0) targetCube.move(-RESCUE_SPEED, -RESCUE_SPEED, durMs);
    else if (backPattern === 1) targetCube.move(-RESCUE_SPEED, slow, durMs);
    else targetCube.move(slow, -RESCUE_SPEED, durMs);
    rescue.retries++;
    rescue.nextActAt = now + durMs + 400;
  }
}

function updateRescueBumped() {
  // ぶつかって止まった側は自力で脱出させず、静止したまま助けを待つ。
  // もう一方が「衝突したときの進行方向に対して横」へ回り込み、横から押して復帰させる
  const now = millis();
  const target = states[rescue.targetIdx];
  const helper = states[rescue.helperIdx];
  const helperCube = cubes[rescue.helperIdx];
  const targetCube = cubes[rescue.targetIdx];

  // 押されてSTUCK_EPS以上動いたら復帰成功。仕切り直し(REGROUP)へ
  if (target.pos !== null && target.lastMoveAt > rescue.startedAt) {
    playSound(targetCube, SE_RESCUE);
    enterRegroup();
    return;
  }

  // 打ち切り判定は押す前に置く。押した直後に判定すると、
  // 上限回目の押しが効いたかどうかを見ないままHELP_NEEDEDへ落ちてしまう
  if (rescue.retries >= RETRY_MAX || now - rescue.startedAt > RESCUE_TIMEOUT) {
    enterHelpNeeded();
    return;
  }

  if (rescue.step === "APPROACH") {
    if (target.pos !== null) {
      const perp = pickPushPerp(target, rescue.retries);
      const approachPoint = clampToSafe(
        vAdd(target.pos, vScale(perp, APPROACH_DIST))
      );
      if (now - helper.lastCmdAt > MOVE_INTERVAL) {
        helperCube.moveTo(approachPoint, RESCUE_SPEED);
        helper.lastCmdAt = now;
      }
      // 到着判定はtargetとの距離ではなく接近地点との距離で見る。
      // 接近地点はtargetからAPPROACH_DIST(60)離れた位置にあるため、
      // target基準ではARRIVE_DIST(25)以内に入れず、永久に次の段階へ進めない
      if (helper.pos !== null && vDist(helper.pos, approachPoint) <= ARRIVE_DIST) {
        rescue.step = "ACT";
        rescue.nextActAt = now;
      }
    }
  } else if (rescue.step === "ACT") {
    if (now >= rescue.nextActAt && target.pos !== null) {
      helperCube.turnToXY(target.pos.x, target.pos.y, RESCUE_SPEED);
      rescue.nextActAt = now + 800; // 旋回し終わるのを待ってから押す
      rescue.step = "PUSH";
    }
  } else if (rescue.step === "PUSH") {
    if (now >= rescue.nextActAt) {
      // 押す瞬間だけ速度を上げる（低速だと押し負けて動かせない）。本人は動かさない
      helperCube.move(PUSH_SPEED, PUSH_SPEED, BUMP_MS);
      rescue.step = "RETREAT";
      rescue.nextActAt = now + BUMP_MS + 200;
    }
  } else if (rescue.step === "RETREAT") {
    if (now >= rescue.nextActAt) {
      // 押せていなければ一旦離れて、次は別の角度から押し直す（回り込みの経路も確保できる）
      helperCube.move(-RESCUE_SPEED, -RESCUE_SPEED, RETREAT_MS);
      rescue.retries++;
      rescue.step = "APPROACH";
      rescue.nextActAt = now + RETREAT_MS + 300;
    }
  }
}

function pickPushPerp(target, retries) {
  // 押す向きの基本は「衝突したときの進行方向の真横」＝cube自体を横方向へ押し出す。
  // 直交2方向のうち、押した先がマット中心へ向かう側を基本にし
  // （＝立ち位置は中心から遠い側）、壁や別の障害物へさらに押し付けてしまうことを避ける。
  // 押せずにリトライが進んだら PUSH_ANGLE_STEPS に沿って角度を変え、別の当たり方を試す
  const center = { x: MAT.centerX, y: MAT.centerY };
  let base;
  if (target.lastHeading === null) {
    // 進行方向が取れないときは、中心から見て外側に立って中心へ向けて押す
    const out = vNorm(vSub(target.pos, center));
    base = vLen(out) === 0 ? { x: 1, y: 0 } : out;
  } else {
    const h = target.lastHeading;
    const perpA = { x: -h.y, y: h.x };
    const perpB = { x: h.y, y: -h.x };
    const candA = vAdd(target.pos, vScale(perpA, APPROACH_DIST));
    const candB = vAdd(target.pos, vScale(perpB, APPROACH_DIST));
    base = vDist(candA, center) >= vDist(candB, center) ? perpA : perpB;
  }
  const stepDeg = PUSH_ANGLE_STEPS[retries % PUSH_ANGLE_STEPS.length];
  return vRotate(base, (stepDeg * Math.PI) / 180);
}

// ==== phase: REGROUP ====
function enterRegroup() {
  phase = "REGROUP";
  rescue = null;
  celebrate = null;
  regroupStartedAt = millis();
  regroupArrivedAt = null;
  // ダンス・救助中の意図的な静止をスタック判定に持ち越すと、帰還開始直後に誤救助が発動する
  resetStuckDetection();
  cubes.forEach((cube) => setLight(cube, LED_HOME));
}

function updateRegroup() {
  // 勝利ダンスの後と救助完了の後は、どちらもここを通る。
  // 起動地点＝各機のスタート地点へ戻してから再開する。役割交代は捕獲時に済ませているのでここでは触らない
  const now = millis();
  let allArrived = true;
  const movingIdx = []; // まだ帰還中の機。トラブル検知はこの機だけを対象にする

  cubes.forEach((cube, i) => {
    const st = states[i];
    const home = homePosOf(i);
    if (st.pos === null) {
      allArrived = false; // 座標が読めない機は到着とみなさない
      movingIdx.push(i);
      return;
    }
    if (vDist(st.pos, home) > HOME_ARRIVE_DIST) {
      allArrived = false;
      movingIdx.push(i);
      if (now - st.lastCmdAt > MOVE_INTERVAL) {
        cube.moveTo(home, SPEED);
        st.lastCmdAt = now;
      }
    }
  });

  // 帰り道でも障害物に引っかかったり、マット外へ落ちたりしたら救助へ。
  // 到着済みの機は意図的に静止しているため検知対象から外す（誤救助の防止）
  const trouble = findTroubleIdx(movingIdx);
  if (trouble !== null) {
    enterRescue(trouble.kind, trouble.idx);
    return;
  }

  // 全機がスタート地点に揃ってから数秒待機し、それから再スタートする。
  // 途中で位置がずれたら（手で動かされた等）待機を数え直す
  if (allArrived) {
    if (regroupArrivedAt === null) regroupArrivedAt = now;
  } else {
    regroupArrivedAt = null;
  }
  const holdDone =
    regroupArrivedAt !== null && now - regroupArrivedAt > REGROUP_HOLD_MS;
  // 戻れない機がいてもデモが止まらないよう打ち切りも設ける
  if (holdDone || now - regroupStartedAt > REGROUP_TIMEOUT) {
    enterChase(); // CHASE遷移時にLEDが役割色(赤/青)へ戻る
  }
}

function homePosOf(idx) {
  // スタート地点は起動時（最初に座標が読めた時点）の位置。
  // 起動時にマットの外にいた場合だけ、マット中心の左右へフォールバックする
  const st = states[idx];
  if (st.homePos !== null) return clampToSafe(st.homePos);
  return { x: MAT.centerX + (idx === 0 ? -80 : 80), y: MAT.centerY };
}

// ==== phase: HELP_NEEDED ====
function enterHelpNeeded() {
  phase = "HELP_NEEDED";
  lastBlinkAt = millis();
  lastSoundAt = 0; // すぐ呼び出し音を鳴らす
  blinkOn = false;
  // 点滅の消灯タイミングでRESCUEを抜けるとhelperが消灯のまま残るため、ここで緑に点け直す。
  // rescueコンテキストは復帰判定に使い続けるのでクリアしない
  setLight(cubes[rescue.helperIdx], LED_RESCUER);
}

function updateHelpNeeded() {
  const now = millis();
  const target = states[rescue.targetIdx];
  const targetCube = cubes[rescue.targetIdx];

  // 自力救助中（オレンジ/緑）と区別できるよう、人待ち中はピンクで点滅させる
  if (now - lastBlinkAt > HELP_BLINK_MS) {
    lastBlinkAt = now;
    blinkOn = !blinkOn;
    if (blinkOn) setLight(targetCube, LED_HELP);
    else targetCube.turnLightOff();
  }

  // 人に気づいてもらうための呼び出し音。サイレンより控えめな間隔で鳴らす
  if (now - lastSoundAt > HELP_CALL_MS) {
    lastSoundAt = now;
    playMelody(targetCube, HELP_MELODY);
  }

  // 座標が復帰し、かつ救助開始後に動いた（＝人が戻した／自力で抜けた）らREGROUPへ
  if (target.pos !== null && target.lastMoveAt > rescue.startedAt) {
    enterRegroup();
  }
}

// ==== 描画 ====
function drawMat() {
  // マット外形の表示
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

function toDisplay(p) {
  // cube座標 → 画面座標。MAT定数から算出するのでマットを変えても破綻しない
  return {
    x: map(p.x, MAT.minX, MAT.maxX, MAT_X, MAT_X + MAT_W),
    y: map(p.y, MAT.minY, MAT.maxY, MAT_Y, MAT_Y + MAT_H),
  };
}

function drawHomes() {
  // 各機のスタート地点（仕切り直しで戻る場所）を薄い円で示す
  for (let i = 0; i < cubes.length; i++) {
    if (states[i].homePos === null) continue;
    const d = toDisplay(homePosOf(i));
    noFill();
    stroke(150);
    strokeWeight(1);
    circle(d.x, d.y, 34);
    noStroke();
    fill(130);
    textAlign(CENTER, CENTER);
    textSize(9);
    text(`START${i + 1}`, d.x, d.y + 24);
  }
}

function drawWaitingMessage(message) {
  fill(100);
  noStroke();
  textSize(20);
  textAlign(CENTER, CENTER);
  text(message, BASE_W / 2, BASE_H / 6);
}

function drawCubes() {
  // キューブの位置表示
  for (let i = 0; i < cubes.length; i++) {
    const cube = cubes[i];
    if (typeof cube.x !== "number" || typeof cube.y !== "number") continue;

    const d = toDisplay({ x: cube.x, y: cube.y });
    const cubeSize = 36;

    // 役割・状態で枠を色分けする（勝者=金枠、トラブル中=太い黄枠、鬼=赤枠、逃げ=青枠）
    const isTrouble = rescue !== null && rescue.targetIdx === i;
    const isWinner = celebrate !== null && celebrate.winnerIdx === i;
    let strokeColor = color(0);
    let strokeW = 2;
    if (isWinner) {
      strokeColor = color(255, 190, 0);
      strokeW = 5;
    } else if (isTrouble) {
      strokeColor = color(230, 190, 0);
      strokeW = 5;
    } else if (i === chaserIdx) {
      strokeColor = color(220, 40, 40);
    } else if (i === runnerIdx) {
      strokeColor = color(40, 90, 220);
    }

    push();
    translate(d.x, d.y);
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

  if (phase === "READY") {
    fill(0, 110, 200);
    text("スタート待ち（押した位置がスタート地点になります）", x, y);
    y += lineH;
    fill(20);
  }
  if (phase === "CELEBRATE") {
    fill(210, 140, 0);
    text(`Cube${celebrate.winnerIdx + 1} の勝ち！ ダンス中`, x, y);
    y += lineH;
    fill(20);
  }
  if (phase === "RESCUE") {
    fill(0, 150, 60);
    text("救助中（緑=助ける側 / オレンジ=助けられる側）", x, y);
    y += lineH;
    fill(20);
  }
  if (phase === "REGROUP") {
    fill(80);
    text(
      regroupArrivedAt !== null
        ? "スタート地点で待機中（数秒後に再スタート）"
        : "スタート地点へ戻って仕切り直し中",
      x,
      y
    );
    y += lineH;
    fill(20);
  }
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
  text(
    "[c]接続 [s]スタート/リスタート [r]仕切り直し [f]全画面 [space]一時停止",
    x,
    y
  );
  pop();
}
