// The world for the search demo: suggestions by prefix, where a SHORTER query
// takes LONGER to answer. That is the classic race weather — the answer for
// "s" lands after the answer for "sto" — arranged on purpose, not found by luck.

const WORDS = [
    'stack', 'stable', 'staff', 'stage', 'stain', 'stair', 'stamp', 'stand',
    'star', 'stare', 'start', 'state', 'station', 'stay', 'steady', 'steam',
    'steel', 'steep', 'stem', 'step', 'stereo', 'stick', 'stiff', 'still',
    'stock', 'stone', 'stool', 'stop', 'store', 'storm', 'story', 'stove',
    'straight', 'strange', 'straw', 'stream', 'street', 'stress', 'stretch',
    'strict', 'strike', 'string', 'strong', 'study', 'stuff', 'style',
]

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export async function suggest(query: string): Promise<string[]> {
    await delay(Math.max(150, 1100 - query.length * 300))
    const q = query.toLowerCase()
    return WORDS.filter(word => word.startsWith(q)).slice(0, 8)
}