export type Limit = { kind: string; percentUsed: number; resetsAt: string | null }

export type Reading = {
  /** Input tokens the last response was answered over. */
  tokens: number
  /** Where auto-compaction runs, or the model window when it is off. */
  compactAt: number
  /** True when compactAt is the auto-compact point rather than the window. */
  isCompactPoint: boolean
  limits: Limit[]
}

declare module 'claude-code' {
  interface PluginState {
    'plan-meter': { reading: Reading | null; warned: string[] }
  }
}
