// The world for the draft demo: a make-believe server with a real temper.
// Answers take time, and every third send is refused — exactly the weather an
// application actually lives in. Its notes live in localStorage, because a
// world that dies with the page would make "survives a reload" a lie.

export interface Note {
  id: number
  text: string
  at: number
}

const KEY = 'draft-demo-server'

function load(): Note[] {
  try {
    const text = localStorage.getItem(KEY)
    const parsed: unknown = text === null ? [] : JSON.parse(text)
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as Note[]
  } catch {
    /* a broken world starts over */
  }
  return [{ id: 1, text: 'The first note was already here.', at: Date.now() - 60_000 }]
}

const notes: Note[] = load()
let sends = 0

const save = (): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(notes))
  } catch {
    /* the world shrugs */
  }
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export async function listNotes(): Promise<Note[]> {
  await delay(500)
  return notes.map(note => ({ ...note }))
}

export async function sendNote(text: string): Promise<Note> {
  await delay(700)
  sends++
  if (sends % 3 === 0) throw new Error('the server is busy, try again')
  const note: Note = { id: Math.max(0, ...notes.map(one => one.id)) + 1, text, at: Date.now() }
  notes.push(note)
  save()
  return note
}
