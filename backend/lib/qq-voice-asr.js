// QQ 语音条 → 文字（DeepSeek ASR）—— backend 侧入口。
//
// 实现已下沉到 src/voice-asr.js：内置桥接（直接收 SnowLuma 语音条）与
// AstrBot 插件桥（backend 转发标识）共用同一份转写逻辑，避免两条链路
// 各自维护一套规则、修一边漏一边。
export { readAsrSettings, transcribeQqVoice } from '../../src/voice-asr.js';
