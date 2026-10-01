// Tipos mínimos do pacote signalsmith-stretch 1.3.2 (não traz .d.ts).
declare module 'signalsmith-stretch' {
  export interface StretchSchedule {
    output?: number
    active?: boolean
    input?: number
    rate?: number
    semitones?: number
    tonalityHz?: number
    formantSemitones?: number
    formantCompensation?: boolean
    formantBaseHz?: number
    loopStart?: number
    loopEnd?: number
  }
  export interface StretchNode extends AudioWorkletNode {
    inputTime: number
    schedule(s: StretchSchedule, adjustPrevious?: boolean): Promise<StretchSchedule>
    start(when?: number, offset?: number, duration?: number, rate?: number, semitones?: number): Promise<unknown>
    stop(when?: number): Promise<unknown>
    addBuffers(buffers: Float32Array[], transfer?: Transferable[]): Promise<number>
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number }>
    latency(): Promise<number>
    configure(c: { blockMs?: number; intervalMs?: number; splitComputation?: boolean; preset?: 'default' | 'cheaper' }): Promise<void>
    setUpdateInterval(seconds: number, cb?: (inputTime: number) => void): Promise<void>
  }
  export default function SignalsmithStretch(ctx: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>
}
