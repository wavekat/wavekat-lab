# CLAUDE.md — notebooks/

Conventions for any Jupyter notebook checked into this directory.

## Banner

Every notebook **must** start with the wavekat-lab banner as its first
cell. This is a markdown cell containing exactly:

```html
<p align="center">
  <a href="https://github.com/wavekat/wavekat-lab">
    <img src="https://github.com/wavekat/wavekat-brand/raw/main/assets/banners/wavekat-lab-narrow.svg" alt="WaveKat Lab">
  </a>
</p>
```

It renders identically on GitHub and in JupyterLab/VS Code/Colab, so a
reader who lands on the notebook from any of those surfaces sees the
brand mark before anything else.

When adding a new notebook:

1. First cell — markdown — banner snippet above (no other content in
   that cell).
2. Second cell — markdown — title (`# Notebook title`) and a short
   description of what the notebook does.

Don't put the banner inside the title cell — keep them separate so the
banner stays editable as one unit if the brand asset URL ever changes.

## Cell completion marker

Every code cell **must** end with a `print("✅ <short message>")` as its
last line. Notebooks are run cell-by-cell — the checkmark gives the
reader a clear "this cell finished cleanly, move on" signal without
having to scan the output.

Pair the checkmark with a meaningful one-line summary of what the cell
just did (`"✅ dataset loaded"`, `"✅ model initialised"`,
`"✅ checkpoint saved"`) — a bare `"✅"` is uninformative. Cells that
already print structured info above should still tail with one summary
line carrying the checkmark.

## Cell outputs

Default to **committing executed outputs** (the Roboflow / fast.ai
pattern) so the notebook reads as a tutorial on GitHub. The repo's
notebooks operate on public data, so leaking project IDs is not a
concern — but be careful with two specific things:

1. **Local absolute paths.** Don't print `Path(...).resolve()` directly;
   print `.name` or a relative form instead, so committed output
   doesn't bake in `/Users/<whoever>/...`.
2. **Authenticated tokens / API keys.** Never `print(token)` or display
   anything that round-trips through an env-var with a credential.

If you must commit a notebook before re-running it after editing the
source, clear the affected cell's outputs (set `outputs: []` and
`execution_count: null`) so stale state doesn't ship.
