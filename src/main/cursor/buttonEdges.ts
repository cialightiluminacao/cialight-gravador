import type { CursorButton } from '@shared/cursor'

// Detecção de clique por consulta (GetAsyncKeyState) a cada tick da amostragem do cursor.
// Bit alto (0x8000) = botão físico pressionado agora; bit baixo (0x0001) = pressionado desde a última consulta
// (a documentação o chama de não confiável: outro processo que consulte o mesmo botão pode "consumi-lo"). Um clique
// conta quando o botão desce entre dois ticks (bit alto e antes solto) ou quando o bit baixo aparece — este último
// pega cliques mais curtos que o tick (melhor esforço). GetAsyncKeyState lê o botão FÍSICO: com botões trocados
// (SM_SWAPBUTTON, canhoto) o físico esquerdo é o clique lógico direito. A primeira leitura (no início e na retomada)
// é descartada pelo CursorRecorder: o bit baixo pode trazer um clique de antes.

export type PhysicalButtonStates = Record<CursorButton, number>

const ORDER: CursorButton[] = ['left', 'right', 'middle']
const isDown = (v: number): boolean => (v & 0x8000) !== 0
const pressedSince = (v: number): boolean => (v & 0x0001) !== 0

export class ButtonEdges {
  private down: Record<CursorButton, boolean> = { left: false, right: false, middle: false }

  /** Botões LÓGICOS que receberam clique desde a última leitura. */
  update(states: PhysicalButtonStates, swapped: boolean): CursorButton[] {
    const out: CursorButton[] = []
    for (const b of ORDER) {
      const v = states[b]
      const now = isDown(v)
      if ((now && !this.down[b]) || pressedSince(v)) out.push(swapped && b !== 'middle' ? (b === 'left' ? 'right' : 'left') : b)
      this.down[b] = now
    }
    return out
  }
}
