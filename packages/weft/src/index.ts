// The front door: everything the library offers the world, in one import.
//
// Behind it the units are separate packages already — graph, async, rel,
// offline, ipc — and anyone who wants only a part takes that part directly.
// This door exists so that an ordinary application does not have to know which
// package a word comes from, and so that the seams above (react, loom) have one
// surface to sit on rather than five.
//
// React does not exist here: hooks live in '#react', the convenient layer in
// '#loom'.

export * from '#graph'
export * from '#async'
export * from '#offline'
export * from '#ipc'
// The relational layer names a node constructor `source`, and the async layer
// names a live source the same. Through the front door the async one wins,
// because that is the word an application means nine times out of ten; the
// node constructor is reached through '#rel', where the tree is being built.
export * from '#rel'
