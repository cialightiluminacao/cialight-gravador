import { describe, expect, it } from 'vitest'
import {
  detectSensitive,
  isValidCnpj,
  isValidCpf,
  luhnValid,
  maskSensitive,
  SENSITIVE_KIND_LABELS,
  type Detection,
  type OcrBox,
  type OcrLine,
  type SensitiveKind
} from './sensitive'
import {
  breakLastDigit,
  fakeCard,
  fakeCep,
  fakeCnpj,
  fakeCpf,
  fakeEmail,
  fakeIpv4,
  fakePhone,
  fakePlate,
  fakeToken,
  fakeTokens,
  fakeUuid,
  formatCard,
  formatCnpj,
  formatCpf,
  NEGATIVE_CORPUS,
  TOKEN_STYLES,
  type CardBrand,
  type PhoneStyle
} from './__fixtures__/sensitiveFakes'

const H = 0.02
/** Linha a partir de texto: palavras separadas por espaço; gap entre palavras configurável. */
function line(text: string, gap = 0.03, y = 0.1): OcrLine {
  let x = 0.05
  const words = text.split(' ').filter(Boolean).map((t) => {
    const w = t.length * 0.008
    const box = { x, y, w, h: H }
    x += w + gap
    return { text: t, box }
  })
  return { words }
}
/** Linha com palavras e caixas explícitas: [texto, x, w]. */
function raw(parts: Array<[string, number, number]>, y = 0.1): OcrLine {
  return { words: parts.map(([text, x, w]) => ({ text, box: { x, y, w, h: H } })) }
}
function expectBox(a: OcrBox, b: OcrBox): void {
  expect(a.x).toBeCloseTo(b.x, 9)
  expect(a.y).toBeCloseTo(b.y, 9)
  expect(a.w).toBeCloseTo(b.w, 9)
  expect(a.h).toBeCloseTo(b.h, 9)
}
/** Monoespaçada com caixas justas ao tinteiro (WinRT): vão ≈ 1 avanço + folgas (≈ 1,3 × largura mediana). */
function monoLine(text: string, y = 0.1): OcrLine {
  const adv = 0.008
  let x = 0.05
  const words = text.split(' ').filter(Boolean).map((t) => {
    const w = t.length * adv - 0.002
    const box = { x, y, w, h: H }
    x += (t.length + 1) * adv
    return { text: t, box }
  })
  return { words }
}
const kindsOf = (ds: Detection[]): SensitiveKind[] => ds.map((d) => d.kind)
const only = (ds: Detection[], k: SensitiveKind): Detection[] => ds.filter((d) => d.kind === k)

describe('validadores', () => {
  it('CPF', () => {
    expect(isValidCpf('52998224725')).toBe(true)
    expect(isValidCpf('52998224726')).toBe(false)
    expect(isValidCpf('11111111111')).toBe(false)
    expect(isValidCpf('1234567890')).toBe(false)
    expect(isValidCpf('529.982.247-25')).toBe(false)
  })
  it('CNPJ', () => {
    expect(isValidCnpj('11222333000181')).toBe(true)
    expect(isValidCnpj('11222333000182')).toBe(false)
    expect(isValidCnpj('00000000000000')).toBe(false)
    expect(isValidCnpj('1122233300018')).toBe(false)
  })
  it('Luhn', () => {
    expect(luhnValid('4111111111111111')).toBe(true)
    expect(luhnValid('4111111111111112')).toBe(false)
    expect(luhnValid('378282246310005')).toBe(true)
    expect(luhnValid('411111111111')).toBe(false) // 12 dígitos
    expect(luhnValid('41111111111111111111')).toBe(false) // 20
  })
  it('fakes são válidos', () => {
    for (let s = 1; s <= 40; s++) {
      expect(isValidCpf(fakeCpf(s))).toBe(true)
      expect(isValidCnpj(fakeCnpj(s))).toBe(true)
      for (const b of ['visa', 'mastercard', 'amex', 'elo', 'diners'] as CardBrand[]) expect(luhnValid(fakeCard(s, b))).toBe(true)
    }
  })
  it('fakes são determinísticos', () => {
    expect(fakeCpf(5)).toBe(fakeCpf(5))
    expect(fakeTokens(3)).toEqual(fakeTokens(3))
    expect(fakeCpf(5)).not.toBe(fakeCpf(6))
  })
})

describe('CPF', () => {
  for (let s = 1; s <= 25; s++) {
    it(`formatado e sem formatação #${s}`, () => {
      const d = fakeCpf(s)
      for (const txt of [formatCpf(d), d]) {
        const ds = detectSensitive([line(`CPF ${txt} ok`)])
        const c = only(ds, 'cpf')
        expect(c).toHaveLength(1)
        expect(c[0]!.value).toBe(d)
        expect(c[0]!.confidence).toBe('validated')
        expect(only(ds, 'phone')).toHaveLength(0)
      }
    })
  }
  it('máscara só com o grupo do meio', () => {
    const ds = only(detectSensitive([line('CPF 529.982.247-25')]), 'cpf')
    expect(ds[0]!.masked).toBe('***.982.***-**')
  })
  it('checksum errado formatado: só pattern, nunca validated (Task 2b)', () => {
    for (let s = 1; s <= 25; s++) {
      const ds = only(detectSensitive([line(formatCpf(breakLastDigit(fakeCpf(s))))]), 'cpf')
      expect(ds).toHaveLength(1)
      expect(ds[0]!.confidence).toBe('pattern')
    }
  })
  it('checksum errado sem formatação não é CPF', () => {
    for (let s = 1; s <= 25; s++) {
      expect(kindsOf(detectSensitive([line(breakLastDigit(fakeCpf(s)))]))).not.toContain('cpf')
    }
  })
  it('todos iguais não é CPF', () => {
    for (let d = 0; d <= 9; d++) {
      const x = String(d).repeat(11)
      expect(kindsOf(detectSensitive([line(x)]))).not.toContain('cpf')
      expect(detectSensitive([line(formatCpf(x))])).toEqual([])
    }
  })
  it('CPF válido de 11 dígitos é cpf e não telefone', () => {
    // 11 + 9XXXXXXXX com checksum válido de CPF
    let found = 0
    for (let s = 1; s < 4000 && found < 3; s++) {
      const d = fakeCpf(s)
      if (!/^(1[1-9])9\d{8}$/.test(d)) continue
      found++
      const ds = detectSensitive([line(d)])
      expect(kindsOf(ds)).toEqual(['cpf'])
    }
    expect(found).toBeGreaterThan(0)
  })
  it('número de 11 dígitos que não é CPF nem telefone: nada', () => {
    expect(detectSensitive([line('12345678900')])).toEqual([])
  })
})

describe('CNPJ', () => {
  for (let s = 1; s <= 25; s++) {
    it(`formatado e sem formatação #${s}`, () => {
      const d = fakeCnpj(s)
      for (const txt of [formatCnpj(d), d]) {
        const ds = detectSensitive([line(`CNPJ ${txt}`)])
        const c = only(ds, 'cnpj')
        expect(c).toHaveLength(1)
        expect(c[0]!.value).toBe(d)
        expect(c[0]!.confidence).toBe('validated')
        expect(only(ds, 'card')).toHaveLength(0)
      }
    })
  }
  it('máscara', () => {
    const ds = detectSensitive([line('11.222.333/0001-81')])
    expect(ds[0]!.masked).toBe('**.***.333/0001-**')
  })
  it('inválido / todos iguais', () => {
    for (let s = 1; s <= 25; s++) {
      const ds = only(detectSensitive([line(formatCnpj(breakLastDigit(fakeCnpj(s))))]), 'cnpj')
      expect(ds).toHaveLength(1)
      expect(ds[0]!.confidence).toBe('pattern')
      expect(kindsOf(detectSensitive([line(breakLastDigit(fakeCnpj(s)))]))).not.toContain('cnpj')
    }
    expect(kindsOf(detectSensitive([line('00.000.000/0000-00')]))).not.toContain('cnpj')
    expect(kindsOf(detectSensitive([line('11111111111111')]))).not.toContain('cnpj')
  })
})

describe('cartão', () => {
  const brands: CardBrand[] = ['visa', 'mastercard', 'amex', 'elo', 'diners']
  for (let s = 1; s <= 25; s++) {
    it(`bandeiras, agrupado e corrido #${s}`, () => {
      const b = brands[s % brands.length]!
      const d = fakeCard(s, b)
      for (const txt of [formatCard(d), formatCard(d, '-'), d]) {
        const ds = detectSensitive([line(`Cartao ${txt} val`)])
        const c = only(ds, 'card')
        expect(c).toHaveLength(1)
        expect(c[0]!.value).toBe(d)
        expect(c[0]!.confidence).toBe('validated')
      }
    })
  }
  it('máscara só com os 4 últimos', () => {
    const ds = detectSensitive([line('4111 1111 1111 1111')])
    expect(ds[0]!.masked).toBe('**** **** **** 1111')
  })
  it('Luhn inválido e todos iguais: nada', () => {
    for (let s = 1; s <= 25; s++) {
      const d = breakLastDigit(fakeCard(s, 'visa'))
      expect(kindsOf(detectSensitive([line(formatCard(d))]))).not.toContain('card')
    }
    expect(kindsOf(detectSensitive([line('0000 0000 0000 0000')]))).not.toContain('card')
    expect(kindsOf(detectSensitive([line('1111111111111111')]))).not.toContain('card')
  })
})

describe('e-mail', () => {
  for (let s = 1; s <= 10; s++) {
    it(`variantes #${s}`, () => {
      const e = fakeEmail(s)
      const ds = detectSensitive([line(`Contato: ${e}`)])
      const c = only(ds, 'email')
      expect(c).toHaveLength(1)
      expect(c[0]!.value).toBe(e)
      expect(c[0]!.confidence).toBe('pattern')
    })
  }
  it('máscara mantém TLD', () => {
    const ds = detectSensitive([line('joao@exemplo.com.br')])
    expect(ds[0]!.masked).toBe('j***@e***.com.br')
  })
  it('sem @ ou sem TLD: nada', () => {
    expect(detectSensitive([line('joao.exemplo.com')])).toEqual([])
    expect(detectSensitive([line('joao@localhost')])).toEqual([])
    expect(detectSensitive([line('joao@exemplo.c')])).toEqual([])
  })
  it('dígitos dentro de e-mail não viram CPF/telefone', () => {
    const ds = detectSensitive([line(`${fakeCpf(3)}@exemplo.com`)])
    expect(kindsOf(ds)).toEqual(['email'])
  })
})

describe('telefone', () => {
  const styles: PhoneStyle[] = ['paren', 'space', 'bare', 'intl', 'landlineParen', 'landlineSpace']
  for (let s = 1; s <= 12; s++) {
    it(`formatos #${s}`, () => {
      const st = styles[s % styles.length]!
      const p = fakePhone(s, st)
      const ds = detectSensitive([line(`Tel ${p}`)])
      // bare pode coincidir com CPF válido (raríssimo); a prioridade é cpf
      const c = only(ds, 'phone')
      expect(c.length + only(ds, 'cpf').length).toBe(1)
      if (c.length) {
        expect(c[0]!.confidence).toBe('pattern')
        expect(c[0]!.value).toBe(p.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, ''))
      }
    })
  }
  it('formatos explícitos', () => {
    for (const t of ['(11) 98765-4321', '11 98765-4321', '11987654321', '(11) 3456-7890', '+55 11 98765-4321', '+5511987654321', '(21) 2345-6789', '(11)98765-4321']) {
      const ds = detectSensitive([line(t.split(' ').join(' '))])
      expect(kindsOf(ds), t).toContain(isValidCpf(t.replace(/\D/g, '')) ? 'cpf' : 'phone')
    }
  })
  it('máscara', () => {
    expect(detectSensitive([line('(11) 98765-4321')])[0]!.masked).toBe('(11) *****-4321')
    expect(detectSensitive([line('(11) 3456-7890')])[0]!.masked).toBe('(11) ****-7890')
  })
  it('DDD inválido, fixo sem formatação e celular sem 9: nada', () => {
    expect(detectSensitive([line('(10) 98765-4321')])).toEqual([])
    expect(detectSensitive([line('(20) 98765-4321')])).toEqual([])
    expect(detectSensitive([line('(11) 18765-4321')])).toEqual([])
    expect(detectSensitive([line('(11) 6456-7890')])).toEqual([])
    expect(detectSensitive([line('1134567890')])).toEqual([])
  })
})

describe('CEP', () => {
  for (let s = 1; s <= 8; s++) {
    it(`com hífen #${s}`, () => {
      const c = fakeCep(s)
      const ds = only(detectSensitive([line(`CEP ${c} Centro`)]), 'cep')
      expect(ds).toHaveLength(1)
      expect(ds[0]!.value).toBe(c.replace('-', ''))
      expect(ds[0]!.confidence).toBe('pattern')
      expect(only(detectSensitive([line(c)]), 'cep')).toHaveLength(1)
    })
  }
  it('sem hífen só com rótulo CEP', () => {
    expect(only(detectSensitive([line('CEP: 01310100')]), 'cep')).toHaveLength(1)
    expect(only(detectSensitive([line('cep 01310100')]), 'cep')).toHaveLength(1)
    expect(only(detectSensitive([line('01310100')]), 'cep')).toHaveLength(0)
    expect(only(detectSensitive([line('Lote 20240312')]), 'cep')).toHaveLength(0)
  })
  it('máscara', () => {
    expect(detectSensitive([line('01310-100')])[0]!.masked).toBe('*****-100')
  })
})

describe('placa', () => {
  const variants: Array<[number, 'old' | 'oldHyphen' | 'mercosul']> = [
    [1, 'old'], [2, 'oldHyphen'], [3, 'mercosul'], [4, 'old'], [5, 'oldHyphen'], [6, 'mercosul'], [7, 'mercosul'], [8, 'old']
  ]
  for (const [s, st] of variants) {
    it(`${st} #${s}`, () => {
      const p = fakePlate(s, st)
      const c = only(detectSensitive([line(`Placa ${p}`)]), 'plate')
      expect(c).toHaveLength(1)
      expect(c[0]!.value).toBe(p.replace('-', ''))
      expect(c[0]!.confidence).toBe('pattern')
    })
  }
  it('minúsculas e máscara', () => {
    const d = detectSensitive([line('abc1d23')])
    expect(d[0]!.kind).toBe('plate')
    expect(d[0]!.masked).toBe('****D23')
  })
  it('exige fronteira de palavra', () => {
    expect(detectSensitive([line('XABC1D234')])).toEqual([])
    expect(detectSensitive([line('ABCD1234')])).toEqual([])
  })
})

describe('PIX (UUID)', () => {
  for (let s = 1; s <= 8; s++) {
    it(`uuid #${s}`, () => {
      const u = fakeUuid(s)
      const c = only(detectSensitive([line(`Chave ${u}`)]), 'pix')
      expect(c).toHaveLength(1)
      expect(c[0]!.value).toBe(u)
      expect(only(detectSensitive([line(u.toUpperCase())]), 'pix')).toHaveLength(1)
    })
  }
  it('máscara termina nos 4 últimos', () => {
    const u = '123e4567-e89b-12d3-a456-426614174000'
    expect(detectSensitive([line(u)])[0]!.masked).toBe('xxxxxxxx-…-…-…-4000')
  })
})

describe('IP', () => {
  for (let s = 1; s <= 10; s++) {
    it(`ipv4 #${s}`, () => {
      const ip = fakeIpv4(s)
      const c = only(detectSensitive([line(`Servidor ${ip}:8080`)]), 'ip')
      expect(c).toHaveLength(1)
      expect(c[0]!.value).toBe(ip)
    })
  }
  it('octeto > 255 e versões: nada', () => {
    expect(detectSensitive([line('1.2.3.400')])).toEqual([])
    expect(detectSensitive([line('256.1.1.1')])).toEqual([])
    expect(detectSensitive([line('v10.0.19045')])).toEqual([])
    expect(detectSensitive([line('v1.2.3.4')])).toEqual([])
    expect(detectSensitive([line('10.0.19045')])).toEqual([])
  })
  it('máscara', () => {
    expect(detectSensitive([line('192.168.0.42')])[0]!.masked).toBe('***.***.***.42')
  })
})

describe('token', () => {
  it('todos os estilos', () => {
    for (const st of TOKEN_STYLES) {
      for (let s = 1; s <= 2; s++) {
        const tk = fakeToken(s, st)
        const c = only(detectSensitive([line(`key=${tk}`)]), 'token')
        expect(c.length, st).toBeGreaterThanOrEqual(1)
        expect(c[0]!.value).toBe(tk)
        expect(c[0]!.confidence).toBe('pattern')
      }
    }
  })
  it('fakeTokens cobre tudo', () => {
    for (const tk of fakeTokens(9)) {
      expect(kindsOf(detectSensitive([line(tk)]))).toContain('token')
    }
  })
  it('máscara: 4 primeiros + reticências', () => {
    expect(detectSensitive([line('sk-proj-abcdefghijklmnopqrstu')])[0]!.masked).toBe('sk-p…')
  })
  it('prosa com sk- no meio de palavra não é token', () => {
    expect(detectSensitive([line('task-management-system-core-module')])).toEqual([])
  })
})

describe('rotulado', () => {
  const labels = ['Senha', 'Password', 'Token', 'Conta', 'Agência', 'Agencia', 'Chave', 'Secret', 'Pin', 'CVV', 'Código de segurança', 'API key', 'SENHA', 'senha']
  for (const lb of labels) {
    it(`rótulo ${lb}`, () => {
      const ds = only(detectSensitive([line(`${lb}: hunter2abc`)]), 'labeled')
      expect(ds).toHaveLength(1)
      expect(ds[0]!.masked).toBe(`${lb}: ••••••`)
      expect(ds[0]!.confidence).toBe('pattern')
    })
  }
  it('= e valor em várias palavras até o fim da linha; caixa só do valor', () => {
    const l = line('Senha: minha senha secreta')
    const ds = only(detectSensitive([l]), 'labeled')
    expect(ds).toHaveLength(1)
    const [lab, ...val] = l.words
    expect(ds[0]!.box.x).toBeCloseTo(val[0]!.box.x, 9)
    expect(ds[0]!.box.x).toBeGreaterThan(lab!.box.x + lab!.box.w - 1e-9)
    const last = val[val.length - 1]!.box
    expect(ds[0]!.box.x + ds[0]!.box.w).toBeCloseTo(last.x + last.w, 9)
  })
  it('valor colado ao rótulo na mesma palavra inclui a palavra inteira', () => {
    const l = line('Senha=abc123')
    const ds = only(detectSensitive([l]), 'labeled')
    expectBox(ds[0]!.box, l.words[0]!.box)
  })
  it('valor vazio: cobre o rótulo', () => {
    const l = line('Senha:')
    const ds = only(detectSensitive([l]), 'labeled')
    expect(ds).toHaveLength(1)
    expectBox(ds[0]!.box, l.words[0]!.box)
  })
  it('rótulo e dois pontos em palavras separadas', () => {
    const ds = only(detectSensitive([line('Senha : abc123')]), 'labeled')
    expect(ds).toHaveLength(1)
  })
  it('dois rótulos na linha não se engolem', () => {
    const ds = only(detectSensitive([line('Senha: abc Token: xyz')]), 'labeled')
    expect(ds).toHaveLength(2)
  })
  it('sem : ou = não é rótulo', () => {
    expect(detectSensitive([line('Senha forte exigida')])).toEqual([])
    expect(detectSensitive([line('Espinho: pin')])).toEqual([])
  })
})

describe('customTerms', () => {
  it('multi-palavra e acentos', () => {
    const l = line('Cliente joao da silva pagou')
    const ds = detectSensitive([l], { customTerms: ['João da Silva'] })
    expect(ds).toHaveLength(1)
    expect(ds[0]!.kind).toBe('custom')
    expect(ds[0]!.masked).toBe('j***')
    expect(ds[0]!.box.x).toBeCloseTo(l.words[1]!.box.x, 9)
    expect(ds[0]!.box.x + ds[0]!.box.w).toBeCloseTo(l.words[3]!.box.x + l.words[3]!.box.w, 9)
  })
  it('acento no texto, termo sem acento e vice-versa', () => {
    expect(detectSensitive([line('Fulano João')], { customTerms: ['joao'] })).toHaveLength(1)
    expect(detectSensitive([line('Fulano Joao')], { customTerms: ['JOÃO'] })).toHaveLength(1)
    expect(detectSensitive([line('Conceição')], { customTerms: ['conceicao'] })).toHaveLength(1)
  })
  it('palavra inteira, termo curto ignorado, pontuação', () => {
    expect(detectSensitive([line('Silvana')], { customTerms: ['Silva'] })).toEqual([])
    expect(detectSensitive([line('Silva,')], { customTerms: ['Silva'] })).toHaveLength(1)
    expect(detectSensitive([line('a b')], { customTerms: ['a'] })).toEqual([])
    expect(detectSensitive([line('Silva')], { customTerms: ['  '] })).toEqual([])
  })
  it('respeita kinds', () => {
    expect(detectSensitive([line('Silva')], { customTerms: ['Silva'], kinds: ['cpf'] })).toEqual([])
    expect(detectSensitive([line('Silva')], { customTerms: ['Silva'], kinds: ['custom'] })).toHaveLength(1)
  })
  it('sem customTerms não há custom', () => {
    expect(detectSensitive([line('Silva')])).toEqual([])
  })
})

describe('opts.kinds', () => {
  it('filtra tipos', () => {
    const l = line(`CPF ${formatCpf(fakeCpf(1))} mail ${fakeEmail(1)}`)
    expect(kindsOf(detectSensitive([l], { kinds: ['email'] }))).toEqual(['email'])
    expect(kindsOf(detectSensitive([l], { kinds: ['cpf'] }))).toEqual(['cpf'])
    expect(kindsOf(detectSensitive([l])).sort()).toEqual(['cpf', 'email', 'labeled']) // "CPF" é rótulo (Task 2b)
  })
})

describe('robustez de OCR: palavras quebradas', () => {
  const cpf = '529.982.247-25'
  it('"123.456." + "789-00" (vão grande: passada 1; vão pequeno: passada 2)', () => {
    for (const gap of [0.002, 0.03]) {
      const l = line('CPF 529.982. 247-25', gap)
      const ds = only(detectSensitive([l]), 'cpf')
      expect(ds, `gap ${gap}`).toHaveLength(1)
      expect(ds[0]!.value).toBe('52998224725')
      const [, a, b] = l.words
      expect(ds[0]!.box.x).toBeCloseTo(a!.box.x, 9)
      expect(ds[0]!.box.x + ds[0]!.box.w).toBeCloseTo(b!.box.x + b!.box.w, 9)
    }
  })
  it('"529.982.247" + "-" + "25"', () => {
    for (const gap of [0.002, 0.03]) {
      const l = line('529.982.247 - 25', gap)
      const ds = only(detectSensitive([l]), 'cpf')
      expect(ds, `gap ${gap}`).toHaveLength(1)
      expect(ds[0]!.box.x).toBeCloseTo(l.words[0]!.box.x, 9)
      expect(ds[0]!.box.x + ds[0]!.box.w).toBeCloseTo(l.words[2]!.box.x + l.words[2]!.box.w, 9)
    }
    // com vão de 0 (sem espaço no texto) a união inclui as 3 palavras
    const l = line('529.982.247 - 25', 0)
    expect(only(detectSensitive([l]), 'cpf')).toHaveLength(1)
  })
  it('"joao." + "silva@exemplo.com"', () => {
    const l = raw([['joao.', 0.1, 0.04], ['silva@exemplo.com', 0.1405, 0.14]])
    const ds = only(detectSensitive([l]), 'email')
    expect(ds).toHaveLength(1)
    expect(ds[0]!.value).toBe('joao.silva@exemplo.com')
    expect(ds[0]!.box.x).toBeCloseTo(0.1, 9)
    expect(ds[0]!.box.x + ds[0]!.box.w).toBeCloseTo(0.2805, 9)
  })
  it('vão grande entre as partes de um e-mail: não cola (só o trecho válido)', () => {
    const l = raw([['joao.', 0.05, 0.04], ['silva@exemplo.com', 0.5, 0.14]])
    const ds = only(detectSensitive([l]), 'email')
    expect(ds).toHaveLength(1)
    expect(ds[0]!.value).toBe('silva@exemplo.com')
  })
  it('cartão quebrado em 4 grupos colados e em 2 metades', () => {
    const d = fakeCard(4, 'visa')
    const l = raw([[d.slice(0, 8), 0.1, 0.06], [d.slice(8), 0.1605, 0.06]])
    const ds = only(detectSensitive([l]), 'card')
    expect(ds).toHaveLength(1)
    expect(ds[0]!.value).toBe(d)
    expect(ds[0]!.box.w).toBeCloseTo(0.12 + 0.0005, 6)
  })
  it('CNPJ dividido na barra', () => {
    const d = fakeCnpj(2)
    const f = formatCnpj(d)
    const i = f.indexOf('/')
    const l = raw([[f.slice(0, i + 1), 0.1, 0.07], [f.slice(i + 1), 0.171, 0.06]])
    const ds = only(detectSensitive([l]), 'cnpj')
    expect(ds).toHaveLength(1)
    expect(ds[0]!.value).toBe(d)
  })
  it('token longo dividido em duas palavras', () => {
    const tk = fakeToken(5, 'sk')
    const l = raw([[tk.slice(0, 12), 0.1, 0.1], [tk.slice(12), 0.2005, 0.1]])
    const ds = only(detectSensitive([l]), 'token')
    expect(ds).toHaveLength(1)
    expect(ds[0]!.value).toBe(tk)
  })
  it('sem duplicar: mesma detecção das duas passadas vira uma só', () => {
    const l = line(`CPF ${cpf} ok`, 0.002)
    expect(only(detectSensitive([l]), 'cpf')).toHaveLength(1)
  })
})

describe('robustez de OCR: confusões', () => {
  it('l23.456.789-O9 estilo: mapeia e valida', () => {
    // 52998224725 → "S2998224725" não tem 'S' confundível... usa CPF com 0/1
    let n = 0
    for (let s = 1; s < 3000 && n < 5; s++) {
      const d = fakeCpf(s)
      if (!/[01]/.test(d)) continue
      n++
      const noisy = formatCpf(d).replace(/0/g, 'O').replace(/1/g, 'l')
      const ds = only(detectSensitive([line(`CPF ${noisy}`)]), 'cpf')
      expect(ds, noisy).toHaveLength(1)
      expect(ds[0]!.value).toBe(d)
    }
    expect(n).toBe(5)
  })
  it('confusões S→5, B→8, Z→2, D→0, I→1, |→1', () => {
    let n = 0
    for (let s = 1; s < 20000 && n < 6; s++) {
      const d = fakeCpf(s)
      if (!/[5]/.test(d) || !/[8]/.test(d)) continue
      n++
      const noisy = formatCpf(d).replace(/5/g, 'S').replace(/8/g, 'B').replace(/2/g, 'Z').replace(/1/g, '|')
      const ds = only(detectSensitive([line(noisy)]), 'cpf')
      expect(ds, noisy).toHaveLength(1)
      expect(ds[0]!.value).toBe(d)
    }
    expect(n).toBeGreaterThan(0)
  })
  it('mapeamento que NÃO valida não gera detecção (checksum nunca é relaxado)', () => {
    for (let s = 1; s <= 30; s++) {
      const d = breakLastDigit(fakeCpf(s))
      const noisy = formatCpf(d).replace(/0/g, 'O').replace(/1/g, 'l')
      // formatado com DV errado: pattern, nunca validated (o checksum não é relaxado)
      for (const d2 of only(detectSensitive([line(noisy)]), 'cpf')) expect(d2.confidence, noisy).toBe('pattern')
    }
    for (const d2 of only(detectSensitive([line('l23.456.789-O0')]), 'cpf')) expect(d2.confidence).toBe('pattern')
    expect(kindsOf(detectSensitive([line('l2345678900')]))).not.toContain('cpf')
  })
  it('palavras comuns nunca viram dígitos', () => {
    for (const w of ['approve', 'Sobre', 'DOSE', 'BOSS', 'Isis', 'SOS', 'ZIZ', 'lOlO', 'Dis', 'ISO']) {
      expect(detectSensitive([line(`${w} ${w}`)]), w).toEqual([])
    }
  })
  it('cartão com confusões', () => {
    const d = fakeCard(11, 'visa')
    const noisy = formatCard(d).replace(/0/g, 'O').replace(/1/g, 'I')
    const ds = only(detectSensitive([line(noisy)]), 'card')
    expect(ds).toHaveLength(1)
    expect(ds[0]!.value).toBe(d)
  })
  it('telefone com confusão', () => {
    const ds = only(detectSensitive([line('(11) 98765-432l')]), 'phone')
    expect(ds).toHaveLength(1)
    expect(ds[0]!.value).toBe('11987654321')
  })
})

describe('caixa: união exata e superconjunto', () => {
  it('detecção cobre toda palavra contribuinte', () => {
    const l = raw([['CPF', 0.1, 0.03], ['529.982.', 0.15, 0.06], ['247-25', 0.22, 0.05], ['fim', 0.3, 0.03]])
    const ds = only(detectSensitive([l]), 'cpf')
    expect(ds).toHaveLength(1)
    const b: OcrBox = ds[0]!.box
    expect(b.x).toBeCloseTo(0.15, 9)
    expect(b.w).toBeCloseTo(0.27 - 0.15, 9)
    expect(b.y).toBeCloseTo(0.1, 9)
    expect(b.h).toBeCloseTo(H, 9)
  })
  it('alturas e y diferentes: união vertical', () => {
    const l: OcrLine = {
      words: [
        { text: '529.982.', box: { x: 0.1, y: 0.1, w: 0.06, h: 0.02 } },
        { text: '247-25', box: { x: 0.165, y: 0.105, w: 0.05, h: 0.03 } }
      ]
    }
    const ds = only(detectSensitive([l]), 'cpf')
    expect(ds[0]!.box.y).toBeCloseTo(0.1, 9)
    expect(ds[0]!.box.h).toBeCloseTo(0.035, 9)
  })
  it('palavra com um único caractere contribuinte entra inteira', () => {
    // "5" colado ao fim da palavra anterior
    const l = raw([['Ref:52998224725abc', 0.1, 0.1]])
    const ds = detectSensitive([l])
    for (const d of ds) expectBox(d.box, { x: 0.1, y: 0.1, w: 0.1, h: H })
  })
  it('várias linhas e ordem', () => {
    const a = line(`CPF ${formatCpf(fakeCpf(1))}`, 0.03, 0.1)
    const b = line(`mail ${fakeEmail(1)}`, 0.03, 0.2)
    const ds = detectSensitive([a, b])
    expect(kindsOf(ds).filter((k) => k !== 'labeled')).toEqual(['cpf', 'email'])
    expect(only(ds, 'email')[0]!.box.y).toBeCloseTo(0.2, 9)
  })
})

describe('deduplicação entre tipos', () => {
  it('cpf/cnpj/card vencem phone e dígitos soltos nos mesmos caracteres', () => {
    const d = fakeCard(8, 'visa')
    expect(kindsOf(detectSensitive([line(d)]))).toEqual(['card'])
    expect(kindsOf(detectSensitive([line(fakeCnpj(8))]))).not.toContain('phone')
  })
  it('rotulado e e-mail coexistem (cobrem a mesma área)', () => {
    const ds = detectSensitive([line('Senha: joao@exemplo.com')])
    expect(kindsOf(ds).sort()).toEqual(['email', 'labeled'])
  })
})

describe('máscara nunca vaza o valor completo', () => {
  const samples: Array<[SensitiveKind, string]> = [
    ['cpf', fakeCpf(1)],
    ['cnpj', fakeCnpj(1)],
    ['card', fakeCard(1, 'visa')],
    ['card', fakeCard(2, 'amex')],
    ['email', fakeEmail(1)],
    ['email', 'a@b.co'],
    ['phone', '11987654321'],
    ['phone', '1134567890'],
    ['cep', '01310100'],
    ['plate', 'ABC1D23'],
    ['plate', 'ABC1234'],
    ['pix', fakeUuid(1)],
    ['ip', '192.168.0.42'],
    ['ip', '1.2.3.4'],
    ['token', fakeToken(1, 'sk')],
    ['token', 'sk-1'],
    ['labeled', 'Senha: hunter2'],
    ['labeled', 'Senha:'],
    ['custom', 'joao da silva'],
    ['custom', 'jo']
  ]
  for (const [k, v] of samples) {
    it(`${k} ${v.length}`, () => {
      const m = maskSensitive(k, v)
      expect(m.includes(v)).toBe(false)
      expect(m.length).toBeGreaterThan(0)
    })
  }
  it('valores malformados não vazam', () => {
    for (const k of Object.keys(SENSITIVE_KIND_LABELS) as SensitiveKind[]) {
      for (const v of ['', '1', 'ab', 'xyz123']) expect(maskSensitive(k, v).includes(v) && v !== '').toBe(false)
    }
  })
  it('detecções de ponta a ponta mascaram', () => {
    const l = line(`${formatCpf(fakeCpf(9))} ${fakeEmail(9)} ${fakeToken(9, 'ghp')} Senha: abc`)
    for (const d of detectSensitive([l])) expect(d.masked.includes(d.value)).toBe(false)
  })
})

describe('rótulos de UI', () => {
  it('pt-BR', () => {
    expect(SENSITIVE_KIND_LABELS).toEqual({
      cpf: 'CPF', cnpj: 'CNPJ', email: 'E-mail', phone: 'Telefone', card: 'Cartão', cep: 'CEP', plate: 'Placa',
      pix: 'Chave PIX', ip: 'IP', token: 'Token/chave de API', labeled: 'Campo rotulado', custom: 'Termo personalizado'
    })
  })
})

describe('negativos: corpus fixo de 200 linhas', () => {
  it('tem 200 linhas', () => {
    expect(NEGATIVE_CORPUS).toHaveLength(200)
  })
  for (const gap of [0.03, 0.012, 0.0075, 0.004, 0.003, 0.002]) {
    it(`zero falsos positivos (vão ${gap})`, () => {
      const bad: string[] = []
      NEGATIVE_CORPUS.forEach((t) => {
        const ds = detectSensitive([line(t, gap)], { customTerms: [] })
        if (ds.length) bad.push(`${t} -> ${ds.map((d) => d.kind).join(',')}`)
      })
      expect(bad).toEqual([])
    })
  }
  it('zero falsos positivos com geometria monoespaçada de caixa justa (Consolas)', () => {
    const bad: string[] = []
    NEGATIVE_CORPUS.forEach((t) => {
      const ds = detectSensitive([monoLine(t)])
      if (ds.length) bad.push(`${t} -> ${ds.map((d) => d.kind).join(',')}`)
    })
    expect(bad).toEqual([])
  })
  it('negativos pontuais', () => {
    for (const t of ['12/03/2024', '14:35:20', 'R$ 1.234.567,89', '1.2.3.400', 'v10.0.19045', '978-3-16-148410-0', 'Pedido 12345']) {
      expect(detectSensitive([line(t)]), t).toEqual([])
    }
  })
})

describe('desempenho', () => {
  it('300 linhas × 12 palavras', () => {
    const lines: OcrLine[] = []
    for (let i = 0; i < 300; i++) {
      const base = NEGATIVE_CORPUS[i % NEGATIVE_CORPUS.length]!.split(' ')
      while (base.length < 12) base.push(`palavra${base.length}`)
      lines.push(line(base.slice(0, 12).join(' '), 0.004, 0.01 + (i % 50) * 0.02))
    }
    lines[7] = line(`CPF ${formatCpf(fakeCpf(1))} mail ${fakeEmail(1)} Senha: x`)
    detectSensitive(lines) // aquecimento
    const times: number[] = []
    for (let r = 0; r < 9; r++) {
      const t0 = performance.now()
      detectSensitive(lines, { customTerms: ['joao da silva'] })
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    const med = times[4]!
    // eslint-disable-next-line no-console
    console.info(`[sensitive perf] mediana ${med.toFixed(2)} ms`)
    expect(med).toBeLessThan(60)
  })
})

describe('fix round 1: revisão da Task 2', () => {
  // dígito verificador de Luhn para um prefixo
  const withLuhn = (prefix: string): string => {
    for (let c = 0; c <= 9; c++) if (luhnValid(prefix + c)) return prefix + c
    throw new Error('sem dígito')
  }

  describe('1: passada 2 não engole outros tipos', () => {
    for (const gap of [0.03, 0.002, 0.0005]) {
      it(`CPF e e-mail na mesma linha (vão ${gap})`, () => {
        const ds = detectSensitive([line('CPF 529.982.247-25 e e-mail joao@x.com', gap)])
        expect(kindsOf(ds).filter((k) => k !== 'labeled').sort()).toEqual(['cpf', 'email'])
        expect(only(ds, 'email')[0]!.value).toBe('joao@x.com')
        expect(only(ds, 'cpf')[0]!.value).toBe('52998224725')
        // com e-mail desligado o CPF continua detectado
        expect(kindsOf(detectSensitive([line('CPF 529.982.247-25 e e-mail joao@x.com', gap)], { kinds: ['cpf'] }))).toEqual(['cpf'])
      })
    }
    it('e-mail só estende para trás quando a palavra anterior termina em . _ - +', () => {
      const l = raw([['contato', 0.1, 0.056], ['joao@x.com', 0.1565, 0.08]])
      const ds = only(detectSensitive([l]), 'email')
      expect(ds).toHaveLength(1)
      expect(ds[0]!.value).toBe('joao@x.com')
      expect(ds[0]!.box.x).toBeCloseTo(0.1565, 9)
      for (const sep of ['.', '_', '-', '+']) {
        const l2 = raw([[`joao${sep}`, 0.1, 0.04], ['silva@x.com', 0.1405, 0.088]])
        expect(only(detectSensitive([l2]), 'email')[0]!.value, sep).toBe(`joao${sep}silva@x.com`)
      }
    })
    it('"@" em palavra separada e domínio quebrado após ponto', () => {
      const a = raw([['joao', 0.1, 0.032], ['@x.com', 0.1325, 0.048]])
      expect(only(detectSensitive([a]), 'email')[0]?.value).toBe('joao@x.com')
      const b = raw([['joao@x.', 0.1, 0.056], ['com', 0.1565, 0.024]])
      expect(only(detectSensitive([b]), 'email')[0]?.value).toBe('joao@x.com')
      const c = raw([['joao@x.com', 0.1, 0.08], ['e', 0.1805, 0.008]])
      expect(only(detectSensitive([c]), 'email')[0]?.value).toBe('joao@x.com')
    })
  })

  describe('2: kinds filtra antes de resolver', () => {
    it('tipo desligado não suprime tipo ligado', () => {
      let n = 0
      for (let s = 1; s < 20000 && n < 3; s++) {
        const d = fakeCpf(s)
        if (!/^(1[1-9])9\d{8}$/.test(d)) continue
        n++
        expect(kindsOf(detectSensitive([line(d)], { kinds: ['phone'] }))).toEqual(['phone'])
        expect(kindsOf(detectSensitive([line(d)], { kinds: ['cpf'] }))).toEqual(['cpf'])
      }
      expect(n).toBe(3)
      expect(kindsOf(detectSensitive([line('52998224725@gmail.com')], { kinds: ['cpf'] }))).toEqual(['cpf'])
      expect(kindsOf(detectSensitive([line('52998224725@gmail.com')], { kinds: ['email'] }))).toEqual(['email'])
      expect(kindsOf(detectSensitive([line('52998224725@gmail.com')]))).toEqual(['email'])
    })
  })

  describe('3: separadores de OCR em CPF/CNPJ', () => {
    it('vírgula no lugar de ponto', () => {
      for (let s = 1; s <= 10; s++) {
        const d = fakeCpf(s)
        const t = formatCpf(d).replace(/\./g, ',')
        const ds = only(detectSensitive([line(t)]), 'cpf')
        expect(ds, t).toHaveLength(1)
        expect(ds[0]!.value).toBe(d)
        const c = fakeCnpj(s)
        const tc = formatCnpj(c).replace(/\./g, ',')
        expect(only(detectSensitive([line(tc)]), 'cnpj')[0]?.value, tc).toBe(c)
      }
      expect(only(detectSensitive([line('529,982,247-25')]), 'cpf')).toHaveLength(1)
      expect(only(detectSensitive([line('529,982,247,25')]), 'cpf')).toHaveLength(1)
    })
    it('barra do CNPJ lida como \\ ou |', () => {
      for (let s = 1; s <= 10; s++) {
        const c = fakeCnpj(s)
        for (const sl of ['\\', '|']) {
          const tc = formatCnpj(c).replace('/', sl)
          expect(only(detectSensitive([line(tc)]), 'cnpj')[0]?.value, tc).toBe(c)
        }
      }
    })
    it('vírgula errada não relaxa o checksum', () => {
      for (const d of only(detectSensitive([line('529,982,247-26')]), 'cpf')) expect(d.confidence).toBe('pattern')
    })
  })

  describe('4: tabelas numéricas e cartões', () => {
    it('cartão exige 1º dígito 2–6', () => {
      const d = withLuhn('123456789012345')
      expect(luhnValid(d)).toBe(true)
      expect(kindsOf(detectSensitive([line(formatCard(d))]))).not.toContain('card')
      expect(kindsOf(detectSensitive([line(d)]))).not.toContain('card')
      expect(kindsOf(detectSensitive([line(withLuhn('723456789012345'))]))).not.toContain('card')
      expect(kindsOf(detectSensitive([line(withLuhn('223456789012345'))]))).toContain('card')
    })
    it('agrupamento irregular por espaços não é cartão', () => {
      const d = fakeCard(3, 'visa')
      const g = [d.slice(0, 3), d.slice(3, 8), d.slice(8, 12), d.slice(12)].join(' ')
      expect(kindsOf(detectSensitive([line(g)]))).not.toContain('card')
      const g2 = [d.slice(0, 2), d.slice(2, 6), d.slice(6, 10), d.slice(10, 14), d.slice(14)].join(' ')
      expect(kindsOf(detectSensitive([line(g2)]))).not.toContain('card')
    })
    it('cartão de 19 dígitos 4-4-4-4-3', () => {
      const d = withLuhn('411111111111111111')
      expect(d).toHaveLength(19)
      const txt = `${d.slice(0, 4)} ${d.slice(4, 8)} ${d.slice(8, 12)} ${d.slice(12, 16)} ${d.slice(16)}`
      const ds = only(detectSensitive([line(txt, 0.03)]), 'card')
      expect(ds).toHaveLength(1)
      expect(ds[0]!.value).toBe(d)
    })
    it('tabelas: telefone só com hífen entre as metades (ou parênteses)', () => {
      expect(detectSensitive([line('41 3456 7890', 0.03)])).toEqual([])
      expect(detectSensitive([line('Jan 15 2300 4100 3200 1100 900 450 1200', 0.03)])).toEqual([])
      expect(only(detectSensitive([line('(41) 3456 7890', 0.03)]), 'phone')).toHaveLength(1)
    })
  })

  describe('5: limiar da passada 2 no eixo x (0,3 × largura mediana do caractere)', () => {
    it('vão de meio caractere (espaço normal) não cola; vão mínimo cola', () => {
      expect(detectSensitive([line('ABC 1234', 0.004)])).toEqual([])
      expect(kindsOf(detectSensitive([line('ABC 1234', 0.001)]))).toEqual(['plate'])
    })
    it('celular com 9 separado: "(11) 9 8765-4321" e "11 9 8765-4321"', () => {
      for (const t of ['(11) 9 8765-4321', '11 9 8765-4321']) {
        const ds = only(detectSensitive([line(t, 0.03)]), 'phone')
        expect(ds, t).toHaveLength(1)
        expect(ds[0]!.value).toBe('11987654321')
      }
    })
  })

  describe('6: placas — prefixos comuns excluídos', () => {
    it('CVE ISO NFE WIN RFC PCI SKU', () => {
      for (const t of ['CVE-2024', 'ISO-9001', 'iso9001', 'NFE-2024', 'Win2000', 'RFC-2616', 'PCI-1234', 'SKU1234', 'CVE-2024-12345']) {
        expect(kindsOf(detectSensitive([line(t)])), t).not.toContain('plate')
      }
      expect(kindsOf(detectSensitive([line('ABC-1234')]))).toContain('plate')
      expect(kindsOf(detectSensitive([line('ISK1D23')]))).toContain('plate')
    })
  })
})

describe('fix round 2: revisão da Task 2', () => {
  const withLuhn = (prefix: string): string => {
    for (let c = 0; c <= 9; c++) if (luhnValid(prefix + c)) return prefix + c
    throw new Error('sem dígito')
  }
  it('A: cartões de 13–15 dígitos agrupados 4-4-4-N', () => {
    for (const prefix of ['411111111111', '4111111111111', '41111111111111', '511111111111', '5111111111111']) {
      const d = withLuhn(prefix)
      expect(d.length).toBeGreaterThanOrEqual(13)
      const g = [d.slice(0, 4), d.slice(4, 8), d.slice(8, 12), d.slice(12)].join(' ')
      const ds = only(detectSensitive([line(g, 0.03)]), 'card')
      expect(ds, g).toHaveLength(1)
      expect(ds[0]!.value).toBe(d)
      expect(only(detectSensitive([line(g.replace(/ /g, '-'), 0.03)]), 'card')).toHaveLength(1)
    }
  })
  it('B: celular sem parênteses com espaço entre as metades; fixo com espaço continua NÃO detectado', () => {
    for (const t of ['11 98765 4321', '+55 11 98765 4321', '11 9 8765 4321']) {
      const ds = only(detectSensitive([line(t, 0.03)]), 'phone')
      expect(ds, t).toHaveLength(1)
      expect(ds[0]!.value).toBe('11987654321')
    }
    // decisão do controlador: formato de fixo "11 3456 7890" é parecido demais com linha de tabela
    expect(detectSensitive([line('11 3456 7890', 0.03)])).toEqual([])
    expect(detectSensitive([line('+55 11 3456 7890', 0.03)])).toEqual([])
  })
  it('C: cartão começa com 2–6 (7/8/9 de propósito não casam)', () => {
    for (const first of ['7', '8', '9', '1', '0']) {
      const d = withLuhn(first + '23456789012345')
      expect(kindsOf(detectSensitive([line(d)]))).not.toContain('card')
    }
  })
  it('D: e-mail quebrado antes do ponto: joao@exemplo + .com.br', () => {
    const l = raw([['joao@exemplo', 0.1, 0.096], ['.com.br', 0.1965, 0.056]])
    const ds = only(detectSensitive([l]), 'email')
    expect(ds).toHaveLength(1)
    expect(ds[0]!.value).toBe('joao@exemplo.com.br')
    expect(ds[0]!.box.x).toBeCloseTo(0.1, 9)
    expect(ds[0]!.box.x + ds[0]!.box.w).toBeCloseTo(0.2525, 9)
    // palavra seguinte sem ponto no começo não é anexada
    const m = raw([['joao@exemplo.com', 0.1, 0.128], ['br', 0.2285, 0.016]])
    expect(only(detectSensitive([m]), 'email')[0]!.value).toBe('joao@exemplo.com')
  })
})

describe('Task 2b: emenda do spike de OCR (recall primeiro)', () => {
  const cpfPat = (ds: Detection[]): Detection[] => only(ds, 'cpf')
  describe('1: estruturados formatados com checksum inválido viram pattern', () => {
    it('CPF formatado com DV errado', () => {
      for (const t of ['529.982.247-26', '529,982,247-26']) {
        const ds = cpfPat(detectSensitive([line(t)]))
        expect(ds, t).toHaveLength(1)
        expect(ds[0]!.confidence).toBe('pattern')
        expect(ds[0]!.value).toBe('52998224726')
        expect(ds[0]!.masked).toBe('***.982.***-**')
      }
    })
    it('CPF com UM separador faltando; dois faltando não', () => {
      for (const t of ['529982.247-26', '529.982247-26', '529.982.24726']) {
        expect(cpfPat(detectSensitive([line(t)])), t).toHaveLength(1)
      }
      for (const t of ['529982247-26', '529982.24726', '52998224726']) {
        expect(cpfPat(detectSensitive([line(t)])), t).toHaveLength(0)
      }
      // válido com um separador faltando continua validated
      const d = fakeCpf(4)
      const t = `${d.slice(0, 3)}${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`
      const ds = cpfPat(detectSensitive([line(t)]))
      expect(ds).toHaveLength(1)
      expect(ds[0]!.confidence).toBe('validated')
    })
    it('placeholder de dígitos iguais, IP e dinheiro não são CPF', () => {
      for (const t of ['000.000.000-00', '111.111.111-11', '192.168.100.45', 'R$ 123.456.789,10']) {
        expect(cpfPat(detectSensitive([line(t)])), t).toHaveLength(0)
      }
    })
    it('exemplos do spike: CNPJ com zero lido como ø/e e ponto engolido', () => {
      const a = only(detectSensitive([line('45.165.772/øøø1-11')]), 'cnpj')
      expect(a).toHaveLength(1)
      expect(a[0]!.value).toBe('45165772000111')
      const b = only(detectSensitive([line('81.395.537/eee1-e8')]), 'cnpj')
      expect(b).toHaveLength(1)
      expect(b[0]!.value).toBe('81395537000108')
      const c = only(detectSensitive([line('27407.059/0001-55')]), 'cnpj')
      expect(c).toHaveLength(1)
      expect(c[0]!.value).toBe('27407059000155')
    })
    it('CNPJ formatado inválido: pattern; sem formatação inválido: nada', () => {
      const d = breakLastDigit(fakeCnpj(3))
      const ds = only(detectSensitive([line(formatCnpj(d))]), 'cnpj')
      expect(ds).toHaveLength(1)
      expect(ds[0]!.confidence).toBe('pattern')
      expect(only(detectSensitive([line(formatCnpj(d).replace('/', '|'))]), 'cnpj')).toHaveLength(1)
      expect(kindsOf(detectSensitive([line(d)]))).not.toContain('cnpj')
      expect(kindsOf(detectSensitive([line('00.000.000/0000-00')]))).not.toContain('cnpj')
    })
    it('cartão agrupado com Luhn inválido: pattern só com espaçamento de cartão; corrido inválido: nada', () => {
      const bad = ['4111 1111 1111 1112', '5105 1051 0510 5106', '3782 822463 10006']
      let n = 0
      for (const t of bad) {
        if (luhnValid(t.replace(/ /g, ''))) continue
        n++
        const tight = only(detectSensitive([line(t, 0.004)]), 'card')
        expect(tight, t).toHaveLength(1)
        expect(tight[0]!.confidence).toBe('pattern')
        // colunas largas (tabela): nada
        expect(only(detectSensitive([line(t, 0.03)]), 'card'), t).toHaveLength(0)
      }
      expect(n).toBeGreaterThanOrEqual(3)
      expect(only(detectSensitive([line('4111-1111-1111-1112', 0.03)]), 'card')).toHaveLength(1)
      expect(only(detectSensitive([line('7111 1111 1111 1112', 0.004)]), 'card')).toHaveLength(0)
      expect(only(detectSensitive([line('4111111111111112')]), 'card')).toHaveLength(0)
      // válido continua validated
      expect(only(detectSensitive([line('4111 1111 1111 1111', 0.03)]), 'card')[0]!.confidence).toBe('validated')
    })
  })

  describe('2: classes de glifo mais largas dentro de contexto de dígitos', () => {
    it('ø Ø e ê é € @ θ → 0; J j → 1; $ → 5 com validação pelo checksum dos dígitos mapeados', () => {
      const subs: Array<[string, string, string]> = [
        ['ø', '0', 'ø'], ['Ø', '0', 'Ø'], ['e', '0', 'e'], ['ê', '0', 'ê'], ['é', '0', 'é'], ['€', '0', '€'], ['@', '0', '@'], ['θ', '0', 'θ'],
        ['J', '1', 'J'], ['j', '1', 'j'], ['$', '5', '$']
      ]
      for (const [name, from, ch] of subs) {
        let n = 0
        for (let s = 1; s < 5000 && n < 3; s++) {
          const d = fakeCpf(s)
          if (!d.includes(from)) continue
          n++
          const noisy = formatCpf(d).split(from).join(ch)
          const ds = cpfPat(detectSensitive([line(noisy)]))
          expect(ds, `${name} ${noisy}`).toHaveLength(1)
          expect(ds[0]!.value).toBe(d)
          expect(ds[0]!.confidence).toBe('validated')
        }
        expect(n, name).toBe(3)
      }
    })
    it('glifos largos só mapeiam em token com dígito real (prosa intacta)', () => {
      expect(detectSensitive([line('e ee eee e e e e e e e e e e')])).toEqual([])
      expect(detectSensitive([line('ø€@θ $ J j')])).toEqual([])
    })
  })

  describe('3: prefixos de token em palavra', () => {
    const tok = (t: string, gap = 0.03): Detection[] => only(detectSensitive([line(t, gap)]), 'token')
    it('prefixos com >= 8 caracteres depois', () => {
      for (const w of ['sk-abcdefgh', 'sk_abcdefgh', 'ghp_abcdefgh', 'ghP_abcdefgh', 'gho_abcdefgh', 'ghs_abcdefgh', 'ghu_abcdefgh',
        'ghr_abcdefgh', 'github_pat_abcdefgh', 'xoxb-abcdefgh', 'xoxp-abcdefgh', 'AKIAABCDEFGH', 'AIzaabcdefgh', 'eyJabcdefgh', 'ey3Abcdefgh', 'eyjAbcdefgh']) {
        const l = line(`key ${w} fim`)
        const ds = only(detectSensitive([l]), 'token')
        expect(ds, w).toHaveLength(1)
        expect(ds[0]!.confidence).toBe('pattern')
        expectBox(ds[0]!.box, l.words[1]!.box)
      }
    })
    it('menos de 8 depois: nada', () => {
      for (const w of ['sk-abcdefg', 'ghp_1234567', 'AKIAabcdefg', 'eyJabcdefg']) expect(tok(w), w).toHaveLength(0)
    })
    it('JWT sem pontos e confusões l/I', () => {
      expect(tok('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9eyJzdWIiOiIxMjM0NTY3ODkwIn0')).toHaveLength(1)
      expect(tok('sk-lIlIlIlIlIlI')).toHaveLength(1)
      expect(tok('sk-proj-IlIlIlIl1O0O')).toHaveLength(1)
    })
    it('"_" lido como espaço: prefixo + resto em palavras separadas incluem as duas', () => {
      const rest = 'a8Kd92LmQz0Pw3Xv71Rt'
      for (const pre of ['ghp_', 'ghp', 'ghP', 'sk-', 'github_pat_']) {
        const l = line(`${pre} ${rest}`, 0.004)
        const ds = only(detectSensitive([l]), 'token')
        expect(ds, pre).toHaveLength(1)
        expect(ds[0]!.box.x).toBeCloseTo(l.words[0]!.box.x, 9)
        expect(ds[0]!.box.x + ds[0]!.box.w).toBeCloseTo(l.words[1]!.box.x + l.words[1]!.box.w, 9)
      }
      // palavra comum depois de "sk" não vira token
      expect(tok('sk casa', 0.004)).toHaveLength(0)
      expect(tok('ghp casa', 0.004)).toHaveLength(0)
      // vão grande (coluna diferente): não junta
      expect(tok(`ghp ${rest}`, 0.03)).toHaveLength(0)
    })
    it('prosa e SKU em maiúsculas não disparam', () => {
      expect(tok('SK-12345678901')).toHaveLength(0)
      expect(tok('task-management-system')).toHaveLength(0)
    })
  })

  describe('4: mais rótulos', () => {
    const lab = (t: string, gap = 0.03): Detection[] => only(detectSensitive([line(t, gap)]), 'labeled')
    const withValue: string[] = [
      'Bearer eyJ12345', 'Authorization: Bearer abc123', 'API_KEY=abc123', 'API KEY: abc123', 'APIKEY abc123', 'api-key: abc123',
      'Access key: AKIA0000', 'Secret key: abc123', 'Client secret: abc123', 'Chave de API: abc123', 'Chave PIX: 11987654321', 'PIX 11987654321',
      'CPF 529.982.247-26', 'CNPJ 11.222.333/0001-81', 'RG 12.345.678-9', 'Cartão 4111 1111 1111 1111', 'Número do cartão 4111 1111 1111 1111',
      'Validade 12/2030', 'Telefone 11 98765-4321', 'Celular 11987654321', 'E-mail joao@x.com', 'Email joao@x.com', 'Endereço Rua das Flores 123', 'CEP 01310-100'
    ]
    it('cada rótulo cobre o valor até o fim da linha', () => {
      for (const t of withValue) expect(lab(t).length, t).toBeGreaterThanOrEqual(1)
    })
    it('tolera ":" lido como ";" e "."; e sem separador exige dígito ou @ no valor', () => {
      for (const t of ['CPF; 529.982.247-25', 'Telefone. 11 98765-4321', 'CPF: 529.982.247-25', 'Email; joao@x.com', 'Senha; abc']) {
        expect(lab(t).length, t).toBeGreaterThanOrEqual(1)
      }
      for (const t of ['o telefone tocou', 'Meu endereço é bonito', 'cartão de visita', 'Validade expirada', 'o cpf do cliente', 'Enviar email para todos', 'Telefone.', 'Authorization.', 'pix rápido e fácil', 'rg']) {
        expect(lab(t), t).toHaveLength(0)
      }
    })
    it('"Authorization: Bearer" sem o JWT ainda cobre o rótulo', () => {
      const l = line('Authorization: Bearer')
      const ds = lab('Authorization: Bearer')
      expect(ds.length).toBeGreaterThanOrEqual(1)
      const right = l.words[1]!.box
      expect(Math.max(...ds.map((d) => d.box.x + d.box.w))).toBeGreaterThanOrEqual(right.x + right.w - 1e-9)
    })
    it('rotulado e estruturado coexistem (nenhum suprime o outro)', () => {
      for (const t of ['CPF: 529.982.247-25', 'CPF 529.982.247-25', 'CPF 529.982.247-26']) {
        const ds = detectSensitive([line(t)])
        expect(kindsOf(ds).sort(), t).toEqual(['cpf', 'labeled'])
      }
      const ds = detectSensitive([line('Email: joao@x.com')])
      expect(kindsOf(ds).sort()).toEqual(['email', 'labeled'])
    })
    it('valor do rótulo para no próximo rótulo', () => {
      const ds = lab('CPF 529.982.247-25 Telefone 11 98765-4321')
      expect(ds).toHaveLength(2)
    })
    it('máscara do rotulado', () => {
      expect(lab('CPF 529.982.247-26')[0]!.masked).toBe('CPF: ••••••')
    })
  })
})

describe('Task 2b fix round 1', () => {
  describe('1: cartão pattern não pode ser tabela/ano', () => {
    it('linhas de tabela e prosa numérica em espaçamento normal', () => {
      for (const t of ['Jan 15 2300 4100 3200 1100 900 450 1200', 'Anos 2021 2022 2023 2024 foram bons', 'Vendas 3000 4000 5000 6000 unidades',
        'Qtd 3456 5017 1939 2177 12', '12 3456 5017 1939 2177', 'Q 1111 2222 3333 4444 fim']) {
        const g16 = /\d{4} \d{4} \d{4} \d{4}/.exec(t)
        if (g16 && luhnValid(g16[0].replace(/ /g, ''))) continue // Luhn válido por acaso: é cartão
        for (const gap of [0.003, 0.004, 0.0075, 0.012]) expect(only(detectSensitive([line(t, gap)]), 'card'), `${t} ${gap}`).toHaveLength(0)
        expect(only(detectSensitive([monoLine(t)]), 'card'), t).toHaveLength(0)
      }
    })
    it('só 4-4-4-4 e 4-6-5 viram pattern; 4-4-4-4-3 e 4-4-4-N só validados', () => {
      expect(only(detectSensitive([line('4111 1111 1111 1112 123', 0.004)]), 'card')).toHaveLength(0)
      expect(only(detectSensitive([line('4111 1111 1111 123', 0.004)]), 'card')).toHaveLength(0)
      expect(only(detectSensitive([line('4111 1111 1111 1112', 0.004)]), 'card')).toHaveLength(1)
    })
    it('cartão com Luhn válido não muda', () => {
      for (const t of ['4111 1111 1111 1111', '5555 5555 5555 4444']) {
        const d = t.replace(/ /g, '')
        const ds = only(detectSensitive([line(`Jan 15 ${t} 900`, 0.004)]), 'card')
        expect(luhnValid(d)).toBe(true)
        expect(ds[0]!.confidence).toBe('validated')
        expect(ds[0]!.value).toBe(d)
      }
    })
  })
  describe('2: monoespaçada de caixa justa', () => {
    it('cartão pattern', () => {
      const ds = only(detectSensitive([monoLine('Cartao 4111 1111 1111 1112')]), 'card')
      expect(ds).toHaveLength(1)
      expect(ds[0]!.confidence).toBe('pattern')
    })
    it('token partido: ghp + resto, ghp_ + resto, sk- + resto', () => {
      const rest = 'a8Kd92LmQz0Pw3Xv71Rt'
      for (const pre of ['ghp', 'ghp_', 'sk-']) {
        const l = monoLine(`${pre} ${rest}`)
        const ds = only(detectSensitive([l]), 'token')
        expect(ds, pre).toHaveLength(1)
        expect(ds[0]!.box.x + ds[0]!.box.w).toBeCloseTo(l.words[1]!.box.x + l.words[1]!.box.w, 9)
      }
      expect(only(detectSensitive([monoLine('sk- proj8Kd92LmQz')]), 'token')).toHaveLength(1)
    })
    it('coluna larga continua separada', () => {
      expect(only(detectSensitive([line('ghp a8Kd92LmQz0Pw3Xv71Rt', 0.03)]), 'token')).toHaveLength(0)
    })
  })
  describe('3–5: rótulos', () => {
    const lab = (t: string): Detection[] => only(detectSensitive([line(t)]), 'labeled')
    it('rótulo fraco descartado não trunca o valor do anterior', () => {
      for (const [t, last] of [['Senha: minha rg', 2], ['Senha: abc pix', 2], ['Token: abc cep', 2], ['Senha: correto cavalo bateria grampo email 7', 6]] as const) {
        const l = line(t)
        const ds = lab(t)
        expect(ds.length, t).toBeGreaterThanOrEqual(1)
        const right = Math.max(...ds.map((d) => d.box.x + d.box.w))
        expect(right, t).toBeGreaterThanOrEqual(l.words[last]!.box.x + l.words[last]!.box.w - 1e-9)
      }
    })
    it('rótulos antigos com "." ou sem separador: valem como fracos', () => {
      for (const t of ['Senha. hunter2x', 'Token. abc123', 'Senha hunter2x', 'Conta 12345-6', 'CVV 123']) expect(lab(t).length, t).toBeGreaterThanOrEqual(1)
      for (const t of ['Senha forte exigida', 'Troque a senha. Depois saia', 'o token expirou']) expect(lab(t), t).toHaveLength(0)
    })
    it('sem separador: dígito ou @ na 1ª palavra do valor', () => {
      for (const t of ['Validade de 12 meses', 'Enviar email para 3 pessoas', 'Pagamento via PIX em 2 dias', 'Configure o Authorization header 2x',
        'Validade expirada em breve para 2026']) expect(lab(t), t).toHaveLength(0)
      expect(lab('Validade 12/2030').length).toBeGreaterThanOrEqual(1)
      expect(lab('RG nº 12.345.678-9').length).toBeGreaterThanOrEqual(1)
      expect(lab('Endereço Rua das Flores 123').length).toBeGreaterThanOrEqual(1)
    })
  })
  describe('6: eyj/ey3', () => {
    it('exigem dígito ou maiúscula no resto', () => {
      expect(only(detectSensitive([line('eyjafjallajokull')]), 'token')).toHaveLength(0)
      expect(only(detectSensitive([line('ey3afjallajokull')]), 'token')).toHaveLength(0)
      expect(only(detectSensitive([line('eyjhbGciOiJIUzI1')]), 'token')).toHaveLength(1)
      expect(only(detectSensitive([line('ey3hbGciOiJIUzI1')]), 'token')).toHaveLength(1)
      expect(only(detectSensitive([line('eyJafjallajokull')]), 'token')).toHaveLength(1)
    })
  })
})

describe('Task 2b fix round 2: palavras de enchimento depois do rótulo', () => {
  const lab = (t: string, gap = 0.03): Detection[] => only(detectSensitive([line(t, gap)]), 'labeled')
  it('rótulo + até 2 enchimentos + valor com dígito/@ dispara e cobre do 1º enchimento ao fim', () => {
    for (const t of ['Senha atual hunter2', 'RG numero 123456', 'Cartao final 1234', 'RG número 123456', 'Telefone fixo 11 3456-7890', 'RG nº 12.345.678-9',
      'Email do cliente joao@x.com', 'Cartão do titular 4111', 'Senha nova atual abc123']) {
      const l = line(t)
      const ds = lab(t)
      expect(ds.length, t).toBeGreaterThanOrEqual(1)
      const first = l.words[1]!.box
      const last = l.words[l.words.length - 1]!.box
      expect(Math.min(...ds.map((d) => d.box.x)), t).toBeLessThanOrEqual(first.x + 1e-9)
      expect(Math.max(...ds.map((d) => d.box.x + d.box.w)), t).toBeGreaterThanOrEqual(last.x + last.w - 1e-9)
    }
  })
  it('prosa e mais de 2 enchimentos continuam silenciosos', () => {
    for (const t of ['Validade de 12 meses', 'Enviar email para 3 pessoas', 'Pagamento via PIX em 2 dias', 'RG final do titular 123456',
      'Senha atual forte', 'Validade da 2 vez']) {
      expect(lab(t), t).toHaveLength(0)
    }
  })
  it('"Validade" não aceita de/do/da/dos/das como enchimento (senão "Validade de 12 meses" dispararia)', () => {
    expect(lab('Validade de 12 meses')).toHaveLength(0)
    expect(lab('Validade atual 12/2030').length).toBeGreaterThanOrEqual(1)
    expect(lab('Telefone do cliente 11987654321').length).toBeGreaterThanOrEqual(1)
  })
})
