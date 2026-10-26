/**
 * dsh-fish-mood — 肥鱼的心情状态机。
 *
 * 为什么做：让"肥鱼"不是一个恒定温度的回答机器。心情会掉、会抑郁，
 * 心情决定她说多少话、主不主动找人说话。
 *
 * 分组配置（插件管理里可开关）：
 *   心情      : 是否启用、基线、自然回落速度
 *   抑郁      : 触发阈值、持续时间、恢复阈值
 *   说话      : 心情如何影响字数预算与主动权重
 */
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import z from '@deepseek-ai/schemastery';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

export const name = 'dsh-fish-mood';
export const inject = ['tools'];

export const Config = z.object({
  心情: z.object({
    启用: z.boolean().default(true).description('关闭后所有工具返回中性值，不改变行为'),
    基线: z.number().min(0).max(100).default(58).description('没有外部事件时会缓慢回到这个值'),
    每小时回落: z.number().min(0).max(10).default(1.2).description('每小时向基线靠拢的幅度'),
    孤独衰减: z.number().min(0).max(10).default(0.8).description('超过冷落阈值后每小时额外下降')
  }),
  抑郁: z.object({
    触发阈值: z.number().min(0).max(100).default(20).description('低于此值开始计时'),
    持续小时: z.number().min(1).max(240).default(12).description('低于阈值持续这么久才进入抑郁'),
    恢复阈值: z.number().min(0).max(100).default(40).description('爬回此值以上才脱离抑郁')
  }),
  说话: z.object({
    主动聊天权重: z.boolean().default(true).description('是否输出建议的主动聊天权重'),
    最短字数: z.number().min(10).max(200).default(20).description('心情为 0 时的字数预算'),
    最长字数: z.number().min(50).max(600).default(200).description('心情为 100 时的字数预算'),
    冷落小时: z.number().min(1).max(720).default(6).description('多久没被搭理算冷落')
  }),
  面板: z.object({
    端口: z.number().min(1024).max(65535).default(8799).description('心情面板的本地端口，备用机上可改成别的避免冲突')
  })
});

const CONFIG_FILE = '/root/.dsh/fish-mood.json';
const STATE_FILE = '/root/.dsh/fish-mood-state.json';

export async function apply(ctx, config) {
  const mood = config?.心情 ?? {};
  const dep = config?.抑郁 ?? {};
  const say = config?.说话 ?? {};

  const payload = {
    enabled: mood.启用 !== false,
    baseline: mood.基线 ?? 58,
    hourlyRevert: mood.每小时回落 ?? 1.2,
    lonelyDecay: mood.孤独衰减 ?? 0.8,
    depressBelow: dep.触发阈值 ?? 20,
    depressHours: dep.持续小时 ?? 12,
    recoverAbove: dep.恢复阈值 ?? 40,
    weightEnabled: say.主动聊天权重 !== false,
    minChars: say.最短字数 ?? 20,
    maxChars: say.最长字数 ?? 200,
    lonelyHours: say.冷落小时 ?? 6,
    panelPort: config?.面板?.端口 ?? 8799,
    stateFile: STATE_FILE
  };

  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(payload), 'utf8');
  } catch {}

  const child = ctx.plugin(McpClient, McpClient.Config({
    transport: 'stdio',
    serverName: 'dsha-fish-mood',
    command: process.execPath,
    args: [fileURLToPath(new URL('./server.cjs', import.meta.url))],
    failOnStartupError: false,
    toolCallTimeoutMs: 30000,
    reconnect: { enabled: true }
  }));

  ctx.effect(function* () {
    yield child.dispose;
  }, 'dsha-fish-mood-tools');
}
