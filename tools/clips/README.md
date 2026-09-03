# Shot modules

One file per authored shot, so a future clip can read how an earlier one was
done instead of archaeologising a diff of `trailer.mjs`.

A shot module exports a factory that takes the harness context `trailer.mjs`
builds (page, arg, hold, step, grant, settle, FPS) and returns:

```js
{
  beat,            // { name, secs, hour, fov, pose } — appended to BEATS
  setup: async () => info,   // place the world; may REHEARSE and throw
  camera: (u) => {},         // per-frame, u in 0..1 across the beat
  driver: null,              // per-frame world driving, or null
}
```

`trailer.mjs` registers these after its own beats, so `--only <name>` films one.

| file | shot | notes |
|---|---|---|
| `cliff.mjs` | camper drives off a bluff and lands | purpose-built lip finder + a rehearsal gate |
