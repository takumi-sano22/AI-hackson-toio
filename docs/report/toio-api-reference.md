# toio 実装リファレンス（AI 参照用）

> **用途**: このリポジトリで toio のコードを書く際に Claude が参照する一次資料。密度優先で書いてあり、読み物ではない。
> 人間向けの概要・企画判断用は [`toio-capability-report.md`](./toio-capability-report.md) を参照。
>
> **調査日**: 2026-07-25
> **前提**: 本リポジトリは **p5.toio**（p5.js 用ライブラリ）を使用。ライブラリ非依存のハード能力は BLE 仕様書に準拠。

---

## 0. 実装前に必ず読む「落とし穴」

事故率が高い順に並べてある。API を叩く前にここを確認すること。

| # | 落とし穴 | 正しい扱い |
|---|---|---|
| 1 | **モーター速度は絶対値 8 未満が無効** | `move(3, 3)` は動かない。有効域は `-115〜-8` / `8〜115` / `0`。微速移動は速度ではなく `duration` を短くして実現する |
| 2 | **`duration` の単位は msec だが分解能は 10ms** | BLE 仕様は 10ms 単位（0〜255）。`move(s, s, 25)` のような 10ms 未満の端数を含む指定は 2〜3 ステップ相当に量子化される（**丸めの方向は未確認**）。最大 2550ms、`0` は無期限（次の書き込みまで継続） |
| 3 | **`angle` の単位は p5 の `angleMode()` に追従** | 既定は `RADIANS`。`angleMode(DEGREES)` を呼ぶと `cube.angle` も `turnTo()` も度になる。混在させない |
| 4 | **Web Bluetooth の接続はユーザー操作イベント内からしか呼べない** | `connectNewP5tCube()` は必ずボタンの `mousePressed` 等から呼ぶ。`setup()` で自動接続は不可 |
| 5 | **複数台接続は 1 台ずつダイアログが出る** | N 台なら N 回クリックが必要。一括接続 API は存在しない |
| 6 | **衝突・ダブルタップはプロパティで取れない** | `addEventListener('sensorcollision', ...)` のみ。ポーリング不可 |
| 7 | **マット外に出ると `cube.x` / `cube.y` が `undefined` になる** | 描画・計算前に `typeof cube.x === 'number'` で必ずガードする |
| 8 | **p5.toio に未実装の機能がある** | 加速度指定移動・姿勢角(オイラー/クォータニオン)・モーター速度取得・音量指定は**呼べない**。§6 参照 |
| 9 | **色シーケンス（点灯シナリオ）の API が無い** | BLE 仕様には最大 29 ステップのシナリオがあるが p5.toio 未対応。`setTimeout` / `draw()` で自前実装する |
| 10 | **HTTPS または localhost が必須** | Web Bluetooth の要件。`file://` で開くと動かない |

---

## 1. セットアップ

### CDN 読み込み（`index.html`）

```html
<script src="https://cdn.jsdelivr.net/npm/p5@1.9.0/lib/p5.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/p5@1.9.0/lib/addons/p5.sound.min.js"></script>
<script src="https://tetunori.github.io/p5.toio/dist/0.8.0/p5.toio.min.js"></script>
```

- **読み込み順序は p5.js → p5.sound → p5.toio の固定**。
- 最新版は `0.8.0`（タグ上は `v0.8.0-beta`）。**現在の `sample.js` のコメントは `0.5.0` を指しているため、更新を検討する**。
- URL 形式: `https://tetunori.github.io/p5.toio/dist/{version}/p5.toio.min.js`

### 接続

```js
const cubes = [];
// Web Bluetooth の制約でユーザー操作イベント内からしか呼べない
btn.mousePressed(() => {
  P5tCube.connectNewP5tCube().then((cube) => cubes.push(cube));
});
```

| メソッド | シグネチャ | 備考 |
|---|---|---|
| `P5tCube.connectNewP5tCube()` | `static (): Promise<P5tCube>` | デバイス選択ダイアログ → GATT 接続 → 全 Characteristic 準備完了後に resolve |
| `cube.disconnect()` | `(): void` | GATT 切断＋内部状態リセット |

- **接続状態を判定する公開 API（`isConnected` 相当）は無い**。内部に private フラグはあるが公開されていない。切断検知イベントも実装されていないため、自前で「一定時間 `positionid` が来ない」等の代替判定が必要。

---

## 2. 移動（モーター制御）

### メソッド一覧

| メソッド | シグネチャ | 引数の意味・値域 |
|---|---|---|
| `move` | `move(left, right, duration = 0)` | `left`/`right`: 左右モーターの生速度。`-115〜-8` / `8〜115` / `0`（負 = 後退）。`duration`: msec `0〜2550`（`0` = 無期限） |
| `stop` | `stop()` | `move(0, 0)` 相当 |
| `rotate` | `rotate(speed, duration = 0)` | `speed`: `-115〜-8` / `8〜115` / `0`（正 = 時計回り）。その場旋回 |
| `moveTo` | `moveTo(aim, maxSpeed, moveType = 0, easeType = 0, timeout = 5)` | `aim`: `{x, y, angle?, angleType?}`。`maxSpeed`: `8〜115` / `0`。`timeout`: 秒 `1〜255`（`0` は例外的に 10 秒扱い） |
| `moveToMulti` | `moveToMulti(aims, maxSpeed, moveType = 0, easeType = 0, isAppend = false, timeout = 5)` | `aims`: 目標地点の配列（**BLE 仕様上の上限 29 点**）。`isAppend`: `true` = 実行中の複数目標制御に追加 / `false` = 上書き |
| `moveToCube` | `moveToCube(cube, maxSpeed, moveType = 0, easeType = 0, timeout = 5)` | 対象キューブの現在座標へ移動。**距離 30 未満で自動停止** |
| `turnTo` | `turnTo(angle, speed, rotateType = 'efficient', timeout = 5)` | `angle` の単位は `angleMode()` 依存。`speed`: `8〜115` / `0` |
| `turnToXY` | `turnToXY(x, y, speed, rotateType = 'efficient', timeout = 5)` | 指定座標の方を向く |
| `turnToCube` | `turnToCube(cube, speed, rotateType = 'efficient', timeout = 5)` | 対象キューブの方を向く |
| `distanceToXY` / `distanceToCube` | `(...): number` | 距離計算ユーティリティ |
| `relativeAngleToXY` | `(x, y): number` | 相対角度計算ユーティリティ |

### 定数（`P5tCube.moveTypeId` 等の静的プロパティ）

| 定数群 | 値 |
|---|---|
| `moveTypeId` | `efficient: 0`（回転しながら移動） / `withoutBack: 1`（後退なし） / `rotate1st: 2`（回転してから移動） |
| `easeTypeId` | `constant: 0` / `accel: 1` / `decel: 2` / `accelDecel: 3` |
| `angleTypeId` | `absEfficient: 0` / `absPositiveDir: 1` / `absNegativeDir: 2` / `relPositiveDir: 3` / `relNegativeDir: 4` / `noRotate: 5` / `sameAsCurrent: 6` |
| `rotateTypeId` | `efficient: 'efficient'` / `clockwise: 'clockwise'` / `counterClockwise: 'counterClockwise'`（**文字列**であることに注意） |

### 到着判定と応答（BLE 仕様）

- **到着とみなす閾値**: 座標差 15 以内 **かつ** 角度差 4 度以内。これより細かい位置決めはできない。
- 目標指定付き制御は完了時に応答値を返す（p5.toio では応答をハンドリングする公開 API が無いため、**JS からは終了検知できない**。到着判定は `cube.x` / `cube.y` を自前で監視する）。

| 応答値 | 意味 |
|---|---|
| `0x00` | 正常終了（目標到達） |
| `0x01` | タイムアウト |
| `0x02` | toio ID missed（マット外／ID 欠落箇所で停止） |
| `0x03` | 不正なパラメータの組み合わせ（操作破棄） |
| `0x04` | 不正な状態（電源遮断） |
| `0x05` | 他の書き込みに上書きされて終了 |
| `0x06` | 非サポート（最大速度 8 未満・操作破棄） |
| `0x07` | 書き込み操作の追加不可（複数目標指定時） |

---

## 3. ランプ（LED）

| メソッド | シグネチャ | 引数 |
|---|---|---|
| `turnLightOn` | `turnLightOn(color, duration = 0)` | `color`: `p5.Color`（`color()` の戻り値。文字列 `'white'` の直渡しも動作例あり）。`duration`: msec `0〜2550`（`0` = 無期限） |
| `turnLightOnRGB` | `turnLightOnRGB(r, g, b, duration = 0)` | `r`/`g`/`b`: `0〜255` |
| `turnLightOnRGBA` | `turnLightOnRGBA(r, g, b, a, duration = 0)` | `a`: 明度 `0〜255` |
| `turnLightOff` | `turnLightOff()` | — |

- ランプは**底面に 1 個**のみ。
- **`duration` は「点灯後に自動消灯するまでの時間」**であり、次の色への遷移機能ではない。
- BLE 仕様には最大 29 ステップの連続点灯シナリオ（繰り返し回数指定つき）があるが、**p5.toio からは呼べない**。色を切り替えたい場合は `setTimeout` か `draw()` 内のタイマーで自前実装する。

---

## 4. サウンド

| メソッド | シグネチャ | 引数 |
|---|---|---|
| `playSE` | `playSE(idSE)` | `idSE`: 下表の `seId` 定数（`0〜10`） |
| `playSingleNote` | `playSingleNote(note, duration = 30)` | `note`: MIDI ノート番号 `0〜128`（**`128` = 無音／休符**）。`duration`: msec `0〜2550`（`0` = 無期限、既定 `30`） |
| `playMelody` | `playMelody(melody)` | `melody`: `{note, duration}` の配列（**BLE 仕様上の上限 59 音**） |

### 内蔵効果音 ID（`P5tCube.seId`）

| 定数名 | ID | 定数名 | ID |
|---|---|---|---|
| `enter` | 0 | `matOut` | 5 |
| `selected` | 1 | `get1` | 6 |
| `cancel` | 2 | `get2` | 7 |
| `cursor` | 3 | `get3` | 8 |
| `matIn` | 4 | `effect1` | 9 |
| | | `effect2` | 10 |

```js
cube.playMelody([{ note: 60, duration: 300 }, { note: 64, duration: 300 }]); // ド → ミ
```

- **音量指定の API は無い**。p5.toio は内部で常に最大音量（`0xFF`）を送信する。BLE 仕様側には音量パラメータが存在するため、静かにしたい場合は toio.js 等の別ライブラリか生 BLE を検討する。

---

## 5. センサー・状態取得

### プロパティ（ポーリングで読める）

| プロパティ | 型 | 内容 |
|---|---|---|
| `x` / `y` | `number \| undefined` | キューブ中心の座標。**マット外では `undefined`** |
| `angle` | `number \| undefined` | 角度。単位は `angleMode()` 依存（既定 RADIANS） |
| `sensorX` / `sensorY` | `number \| undefined` | 読み取りセンサー位置の座標（キューブ中心とは別） |
| `standardId` | `string \| undefined` | 標準 ID（カード/シール）。定数名または数値文字列。未検出時 `undefined` |
| `buttonPressed` | `boolean \| undefined` | 底面ボタンの押下状態 |
| `flat` | `boolean \| undefined` | 水平検出 |
| `posture` | `string \| undefined` | 姿勢 6 方向（`top` / `bottom` / `back` / `front` / `right` / `left`） |
| `shakeLevel` | `number \| undefined` | シェイク強度 `0〜10` |
| `magnet` | `string \| undefined` | 磁石状態（`noMagnet` / `pattern1`〜`pattern6`） |
| `batteryLevel` | `number \| undefined` | バッテリー残量。BLE 仕様上は 0〜100% を 10% 刻み 11 段階、約 5 秒間隔で通知 |
| `bleProtocolVersion` | `string \| undefined` | BLE プロトコルバージョン |
| `name` | `string \| undefined` | キューブ名 |

- 磁石検知の有効化には `cube.configMagnet(enable: boolean)` を呼ぶ（BLE 仕様上、磁気センサーは**初期状態で無効**）。

### イベント（`addEventListener` のみ。`on〜` 形式は無い）

```js
cube.addEventListener('sensorcollision', () => cube.playSE(P5tCube.seId.effect1));
```

| type | コールバック引数 | 備考 |
|---|---|---|
| `positionid` | `{centerX, centerY, angle, sensorX, sensorY} \| undefined` | マット外で `undefined` |
| `standardid` | `{id, idNum, angle} \| undefined` | 〃 |
| `buttonpress` / `buttonrelease` | なし | |
| `sensorcollision` | なし | **プロパティでは取れない。イベント専用** |
| `sensordoubletap` | なし | **同上** |
| `sensorflat` | `isFlat: boolean` | |
| `sensorposturechange` | `posture: string` | |
| `sensorshakelevelchange` | `shakeLevel: number` | |
| `sensormagnetchange` | `magnet: string` | |
| `batterylevelchange` | `batteryLevel: number` | |

---

## 6. p5.toio では使えない機能（BLE 仕様にはあるが未対応）

**「仕様書にある＝コードで呼べる」ではない。** 以下を企画の前提にしないこと。

| 機能 | 状況 | 回避策 |
|---|---|---|
| 加速度指定モーター制御 | 内部実装に `NOT IMPLEMENTED YET` と明記、公開クラスからもラップされておらず呼び出し不可 | `move()` の速度を `draw()` 内で漸増させて自前で加減速する |
| 姿勢角検出（オイラー角／クォータニオン／高精度オイラー角） | 送受信の実装が見当たらない | 6 方向の `posture` で代替。連続的な傾き角は取得不可 |
| モーター速度情報の取得 | 実装・ドキュメントとも確認できず | 指令値を自分で保持する |
| サウンド音量指定 | API に引数が無く内部固定 `0xFF` | なし（別ライブラリ／生 BLE） |
| 連続点灯シナリオ（最大 29 ステップ） | 未対応 | `setTimeout` / `draw()` で自前実装 |
| 各種設定変更（水平検出しきい値・衝突検出しきい値・ダブルタップ間隔・ID 通知間隔・スピーカー消音など） | `configMagnet` 以外は未対応 | 既定値で運用する |
| モーター制御の応答値ハンドリング | 公開 API 無し | 座標を監視して到着・タイムアウトを自前判定する |
| 磁力の強さ・方向の取得 | 未対応（`magnet` は装着パターン 6 種の文字列のみ） | なし |

> **上記が必要な場合**の選択肢: 公式 SDK の `toio.js`（Node.js）／`toio.py`（Python）／`toio SDK for Unity` はいずれも MIT ライセンスで、より広い仕様をカバーしている。ただしブラウザ完結ではなくなる。

---

## 7. マット定数（`P5tId` 配下）

すべて静的メソッド `isOnMat(x, y): boolean` を持つ。

| クラス | minX | minY | maxX | maxY | centerX | centerY | 固有 |
|---|---|---|---|---|---|---|---|
| `SimpleTileMat`（本体同梱の簡易マット） | 98 | 142 | 402 | 358 | 250 | 250 | `matrixRows = 5`, `matrixColumns = 7`, `getTileCenter()` / `getTileMatrixIndex()` / `getTileRow()` / `getTileColumn()` |
| `ColorTileMat`（トイオ・コレクション 色付きタイル面） | 545 | 45 | 955 | 455 | 750 | 250 | `matrixRows = 9`, `matrixColumns = 9`, `getTileColor(x, y)`, `redTiles` / `blueTiles` / `greenTiles` / `yellowTiles` / `whiteTiles` |
| `RingMat`（トイオ・コレクション 土俵面） | 45 | 45 | 455 | 455 | 250 | 250 | `radius = 190`, `blueLineY = 88`, `greenLineY = 410`, `isInsideCircle()` / `isInFrontOfBlueLine()` / `isInFrontOfGreenLine()` |
| `DevMat01`〜`DevMat12`（開発者用マット 12 分割） | — | — | — | — | — | — | 下表参照 |

### 開発者用マット（`DevMat01`〜`DevMat12`）

| クラス | minX, minY | maxX, maxY | center | | クラス | minX, minY | maxX, maxY | center |
|---|---|---|---|---|---|---|---|---|
| `DevMat01` | 34, 35 | 339, 250 | 187, 143 | | `DevMat07` | 340, 467 | 644, 682 | 492, 575 |
| `DevMat02` | 34, 251 | 339, 466 | 187, 359 | | `DevMat08` | 340, 683 | 644, 898 | 492, 791 |
| `DevMat03` | 34, 467 | 339, 682 | 187, 575 | | `DevMat09` | 645, 35 | 949, 250 | 797, 143 |
| `DevMat04` | 34, 683 | 339, 898 | 187, 791 | | `DevMat10` | 645, 251 | 949, 466 | 797, 359 |
| `DevMat05` | 340, 35 | 644, 250 | 492, 143 | | `DevMat11` | 645, 467 | 949, 682 | 797, 575 |
| `DevMat06` | 340, 251 | 644, 466 | 492, 359 | | `DevMat12` | 645, 683 | 949, 898 | 797, 791 |

### 座標系の定義

- **角度は X 軸方向が 0 度、時計回りが正。**
- 座標は Position ID 独自単位（mm 換算値は公式仕様書に記載を確認できず）。
- `SimpleTileMat` は 500 × 355 相当の描画に対して座標範囲が 304 × 216 なので、**画面座標へのマッピングは必ず `map()` を通す**。

> **実装上の注意**: 現在の `sample.js:122-123` は `map(cube.x, 98, 402, ...)` とマット境界をハードコードしている。マットを変えたときに破綻するため、`targetMat.minX` / `targetMat.maxX` / `targetMat.minY` / `targetMat.maxY` を参照する形が望ましい。

---

## 8. 標準 ID（カード・シール）定数

`cube.standardId` と照合する。`getIdName(value)` / `includes(name)` を持つ。

| クラス | 件数 | 内容 |
|---|---|---|
| `P5tId.SimpleCardNumber` | 10 | `mark0: 3670320` 〜 `mark9: 3670329`（連番） |
| `P5tId.SimpleCardAlphabet` | 26 | `markA: 3670337` 〜 `markZ: 3670362`（連番） |
| `P5tId.SimpleCardSymbol` | 12 | `markExclamation: 3670305`, `markQuestion: 3670335`, `markPlus: 3670315`, `markMinus: 3670317`, `markEqual: 3670333`, `markMultiple: 3670314`, `markDivision: 3670319`, `markPercent: 3670309`, `markUp: 3670366`, `markDown: 3670367`, `markLeft: 3670332`, `markRight: 3670334` |
| `P5tId.Card` | 13 | トイオ・コレクション同梱のバトルカード（`typhoonCard: 3670016`, `rushCard: 3670054`, `goCard: 3670028` ほか） |
| `P5tId.Sticker` | 6 | `speedUpSticker: 3670066`, `speedDownSticker: 3670030`, `wobbleSticker: 3670068`, `panicSticker: 3670032`, `spinSticker: 3670070`, `shockSticker: 3670034` |
| `P5tId.Skunk` | 6 | `blueSkunk: 3670078` ほか計 6 色（青・緑・黄・橙・赤・茶） |
| `P5tId.GameMark` | 25 | ゲームメニュー用マーク |

> **企画への示唆**: 数字 0〜9・アルファベット A〜Z・記号（`+ - × ÷ = ! ? % ↑↓←→`）が連番 ID で揃っているため、**カードを並べて「文字列」や「数式」を物理的に組み立てさせる**入力インターフェースが作れる。

---

## 9. ハードウェア仕様（BLE 仕様書より）

| 項目 | 値 |
|---|---|
| 直進最大速度 | 350 mm/秒 |
| 回転最大速度 | 1500 度/秒 |
| 最大積載重量 | 200 g |
| バッテリー | リチウムイオン、3.7 V / 260 mAh、充電入力 DC 5V 0.3A |
| ランプ | 底面に 1 個（フルカラー） |
| ボタン | 底面に 1 個 |
| 充電・稼働時間 | 充電 約 1.5 時間 / 連続稼働 約 2 時間（**販売サイト経由の情報。公式一次資料での確認は取れていない**） |
| BLE 同時接続台数の上限 | **公式仕様書に記載なし**。実務では 12 台程度の同時制御事例あり（SDK 開発元の技術ブログ） |

### BLE サービス / キャラクタリスティック

Service UUID: `10B20100-5B3B-4571-9508-CF3EFCD7BBAE`

| 機能 | UUID | 操作 |
|---|---|---|
| 読み取りセンサー（位置 ID / 標準 ID） | `10B20101-...` | Read, Notify |
| モーター制御 | `10B20102-...` | Write, Notify |
| ランプ制御 | `10B20103-...` | Write |
| サウンド制御 | `10B20104-...` | Write |
| センサー情報（モーション / 磁気 / 姿勢角） | `10B20106-...` | Write, Read, Notify |
| ボタン | `10B20107-...` | Read, Notify |
| バッテリー | `10B20108-...` | Read, Notify |
| 設定 | `10B201FF-...` | Read, Write, Notify |

> p5.toio 利用時に UUID を直接触ることはない。生 BLE / 他言語 SDK へ移行する場合のみ参照。

---

## 10. 実行環境の制約（Web Bluetooth）

| 項目 | 内容 |
|---|---|
| 対応ブラウザ | **Chrome / Edge のみ**。Safari・Firefox は非対応 |
| iOS / iPadOS | 標準ブラウザ・iOS 版 Chrome とも非対応。**Bluefy 等の専用ブラウザアプリが必要** |
| 配信要件 | **HTTPS または `localhost`** が必須。`file://` では動作しない |
| 接続トリガー | **ユーザー操作イベント（クリック・タップ）内からのみ** `requestDevice` が呼べる |
| デモ時の注意 | 会場の Wi-Fi（2.4GHz）と BLE は干渉しうる。多数のキューブが同時に飛ぶ環境では接続失敗・遅延を想定しておく |

---

## 11. 出典

| 対象 | URL |
|---|---|
| p5.toio 配布サイト・API リファレンス（**非公式・コミュニティ製**） | https://tetunori.github.io/p5.toio/docs/cube/classes/p5tcube |
| p5.toio リポジトリ | https://github.com/tetunori/p5.toio |
| toio コアキューブ技術仕様（BLE） | https://toio.github.io/toio-spec/ |
| toio 公式サイト | https://toio.io/ |

**ライセンス上の注意**: toio 技術仕様書は **CC BY 4.0**（イラスト・3D データは CC BY-ND 4.0）。本ドキュメントは同仕様書の内容を要約・再構成しているため、成果物として公開する場合は提供元・ライセンス・リポジトリ URL の明記が必要。詳細は [`toio-capability-report.md`](./toio-capability-report.md) の「守るべきルール」節を参照。

---

## 12. 検証できていない項目

以下は公式ドキュメント上で確認が取れなかった。**実機で確かめるまで前提にしないこと。**

- BLE 同時接続台数の公式な上限
- キューブの物理サイズ（幅・奥行き・高さの実数値）
- 位置 ID 座標 1 単位の mm 換算値
- 読み取りセンサー位置とキューブ中心のオフセット実数値
- バッテリー連続稼働時間・充電時間の公式一次情報
- `cube.batteryLevel` が % 値そのものか 10% 刻みの段階値か（ソース上のコメントと実装で表記が食い違う）
- p5.toio の npm 公開の有無（`package.json` に `name` / `version` が無く未確認）
