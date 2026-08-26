// What a family costs at its ceiling, and how much cache it keeps there.
//
// Two orders, because the eviction pass walks the map from the oldest and the
// answer must not depend on which kind of member it meets first: watched-first
// is a screen that subscribed before it started churning keys, cold-first is
// the same screen after its watched members were read again and moved to the
// tail. Both must keep the same amount of cold cache.
//
// Each case is run several times and the best is reported: one pass through a
// fresh family measures the compiler warming up more than it measures the
// family.

import { family, subscribe } from '#graph'

const max = 1024
const keys = 50_000

const once = (
  watched: number,
  watchedFirst: boolean,
): { ms: number; size: number; cold: number } => {
  const item = family((id: number) => id, { max })
  const stops: (() => void)[] = []
  const hold = () => {
    for (let i = 0; i < watched; i++) stops.push(subscribe(item(-i - 1), () => {}))
  }
  const fill = () => {
    for (let i = 0; i < max; i++) item(i)
  }
  if (watchedFirst) {
    hold()
    fill()
  } else {
    fill()
    hold()
    // reading a watched member moves it to the tail, so the cold ones lead
    for (let i = 0; i < watched; i++) item(-i - 1)
  }

  const started = performance.now()
  for (let i = 0; i < keys; i++) item(max + i)
  const ms = performance.now() - started

  let cold = 0
  for (const key of item.keys()) if (!item(key).observed) cold++
  for (const stop of stops) stop()
  return { ms, size: item.size, cold }
}

const run = (label: string, watched: number, watchedFirst: boolean): void => {
  let best = once(watched, watchedFirst)
  for (let i = 0; i < 4; i++) {
    const next = once(watched, watchedFirst)
    if (next.ms < best.ms) best = next
  }
  console.log(
    `${label.padEnd(28)} size ${String(best.size).padStart(5)}  cold ${String(best.cold).padStart(5)}` +
      `  ${best.ms.toFixed(1).padStart(7)}ms  ${((best.ms * 1e6) / keys).toFixed(0).padStart(5)}ns/key`,
  )
}

console.log(`ceiling ${max}, ${keys} fresh keys after filling it\n`)
run('no watchers', 0, true)
run('512 watched, watched first', 512, true)
run('512 watched, cold first', 512, false)
run('2048 watched, watched first', 2048, true)
run('2048 watched, cold first', 2048, false)
