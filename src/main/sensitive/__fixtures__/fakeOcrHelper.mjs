// Helper de OCR FALSO (testes de ocrHelper.ts): fala o protocolo do resources/ocr/ocr-winrt.ps1 sem OCR.
// Modo (argv[2]): ok | notready | hang (não responde quadros) | ignorequit (não sai com quit) | garbage (resposta não-JSON)
const mode = process.argv[2] ?? 'ok'
const send = (o) => process.stdout.write(typeof o === 'string' ? o + '\n' : JSON.stringify(o) + '\n')
if (mode === 'notready') {
  send({ ready: false, error: 'idioma de OCR não instalado: xx-XX' })
  process.exit(2)
}
send({ ready: true, lang: 'en-US', maxDim: 10000, startMs: 5 })
let buf = Buffer.alloc(0)
let need = null
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  for (;;) {
    if (need === null) {
      const i = buf.indexOf(10)
      if (i < 0) return
      const req = JSON.parse(buf.subarray(0, i).toString('ascii'))
      buf = buf.subarray(i + 1)
      if (req.cmd === 'quit') {
        if (mode !== 'ignorequit') process.exit(0)
        continue
      }
      need = req
    }
    if (buf.length < need.len) return
    const px = buf.subarray(0, need.len)
    buf = buf.subarray(need.len)
    const req = need
    need = null
    if (mode === 'hang') continue
    if (mode === 'garbage') { send('isto não é json'); continue }
    // "lê" a soma dos bytes como texto, para provar que o quadro chegou inteiro
    let sum = 0
    for (const b of px) sum += b
    send({ id: req.id, ok: true, ms: { read: 0, ocr: 0 }, lines: [{ t: `soma ${sum}`, w: [['soma', 1, 2, 3, 4], [String(sum), 5, 2, 3, 4]] }] })
  }
})
process.stdin.on('end', () => {
  if (mode === 'ignorequit') setInterval(() => {}, 1000) // fica vivo: o cliente precisa matar o PID
  else process.exit(0)
})
