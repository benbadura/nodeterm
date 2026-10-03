import { describe, expect, it } from 'vitest'
import { QUESTION_TEXT_MAX_CHARS, QUESTIONS_MAX, readQuestions } from './permission-answer'

// Real shape: AskUserQuestion's `questions`, copied from a transcript's toolUseResult (v2.1.258).
const REAL = [
  {
    question: "Canvas'a baktığında bir ipin sana öncelikle NEYİ söylemesini istiyorsun?",
    header: 'İp anlamı',
    options: [
      { label: 'Sıra / bağımlılık (Recommended)', description: 'Kim kimden sonra çalışır (--after).' },
      { label: 'Kim kimi okuyabilir (context)', description: 'Bilgi akışı asıl şey.' }
    ],
    multiSelect: false
  },
  {
    question: 'Which surfaces should get it?',
    header: 'Surfaces',
    options: [{ label: 'Desktop' }, { label: 'Server Edition', description: 'Browser' }],
    multiSelect: true
  }
]

describe('readQuestions — the ONE reader of an AskUserQuestion input for the answer UI', () => {
  it('reads a real input exactly (the texts are answer keys and must never be altered)', () => {
    expect(readQuestions({ questions: REAL })).toEqual([
      {
        question: REAL[0].question,
        header: 'İp anlamı',
        multiSelect: false,
        options: [
          { label: 'Sıra / bağımlılık (Recommended)', description: 'Kim kimden sonra çalışır (--after).' },
          { label: 'Kim kimi okuyabilir (context)', description: 'Bilgi akışı asıl şey.' }
        ]
      },
      {
        question: 'Which surfaces should get it?',
        header: 'Surfaces',
        multiSelect: true,
        options: [{ label: 'Desktop' }, { label: 'Server Edition', description: 'Browser' }]
      }
    ])
  })

  it('a question with no options (the free-text variant) is kept with an empty option list', () => {
    expect(readQuestions({ questions: [{ question: 'Name?', kind: 'text' }] })).toEqual([
      { question: 'Name?', multiSelect: false, options: [] }
    ])
  })

  it('refuses the WHOLE input rather than dropping a question it cannot read', () => {
    // A partial list would let the UI submit an answer that silently skips a question.
    expect(readQuestions({ questions: [REAL[0], { question: '' }] })).toBeUndefined()
    expect(readQuestions({ questions: [REAL[0], 'nope'] })).toBeUndefined()
    expect(readQuestions({ questions: [{ question: 'Q', options: [{ label: 7 }] }] })).toBeUndefined()
    expect(readQuestions({ questions: [] })).toBeUndefined()
    expect(readQuestions({})).toBeUndefined()
    expect(readQuestions(null)).toBeUndefined()
  })

  it('refuses oversized input instead of truncating an answer key', () => {
    const long = 'x'.repeat(QUESTION_TEXT_MAX_CHARS + 1)
    expect(readQuestions({ questions: [{ question: long, options: [] }] })).toBeUndefined()
    expect(readQuestions({ questions: [{ question: 'Q', options: [{ label: long }] }] })).toBeUndefined()
    const many = Array.from({ length: QUESTIONS_MAX + 1 }, (_, i) => ({ question: `Q${i}`, options: [] }))
    expect(readQuestions({ questions: many })).toBeUndefined()
  })

  it('a duplicated question text is refused (answers are keyed by it)', () => {
    expect(readQuestions({ questions: [REAL[1], REAL[1]] })).toBeUndefined()
  })
})
