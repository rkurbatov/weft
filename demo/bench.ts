import { subscribe } from '#weft'
import { sampleSheet, sizeOf, key } from './common/sample.ts'
import { createSheet as classic } from './spreadsheet/store.ts'
import { createSheet as onWeft } from './spreadsheet-weft/sheet.ts'

const rows = Number(process.argv[2] ?? 1000)
const shape = { rows, cols: 26 }
const VISIBLE = 30 // rows a screen shows
const cells = sampleSheet(shape)
const onScreen: string[] = []
for (let row = 0; row < VISIBLE; row++) for (let col = 0; col < shape.cols; col++) onScreen.push(key(row, col))

console.log(`sheet ${shape.rows}x${shape.cols} = ${sizeOf(shape).toLocaleString()} cells, ${onScreen.length} of them on screen\n`)

{
    const t0 = performance.now()
    const sheet = classic(cells)
    const built = performance.now() - t0
    let told = 0
    for (const at of onScreen) sheet.subscribe(at, () => told++)
    sheet.resetRecomputes()
    const t1 = performance.now()
    sheet.set('A1', '2')
    const edit = performance.now() - t1
    console.log(`classic   build ${built.toFixed(0)}ms | edit A1 ${edit.toFixed(1)}ms | recomputed ${sheet.recomputes()} | cells told ${told}`)
}

{
    const t0 = performance.now()
    const sheet = onWeft(cells)
    const laid = performance.now() - t0
    let told = 0
    const t1 = performance.now()
    const stops = onScreen.map(at => subscribe(sheet.shown(at), () => told++))
    const firstPaint = performance.now() - t1
    const worked = sheet.recomputes()
    sheet.resetRecomputes()
    const t2 = performance.now()
    sheet.set('A1', '2')
    const edit = performance.now() - t2
    console.log(`on weft   lay out ${laid.toFixed(0)}ms + first look ${firstPaint.toFixed(0)}ms (${worked} cells) | edit A1 ${edit.toFixed(1)}ms | recomputed ${sheet.recomputes()} | cells told ${told}`)
    for (const stop of stops) stop()
}