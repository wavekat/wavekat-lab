# Smart-Turn notebooks

Workflow notebooks for the binary smart-turn (end-of-turn vs continuation)
task, picking up from a `wk exports adapt smart-turn` snapshot.

| Notebook | Purpose |
|---|---|
| `01_load_export.ipynb` | Load Parquet shards, sanity-check splits / label balance / clip durations, audition a few clips. |

## Producing the input

Use [`wavekat-cli`](https://github.com/wavekat/wavekat-cli):

```sh
wk exports create <project-id> \
  --name "smart-turn-zh $(date +%Y-%m-%d)" \
  --review-status approved \
  --label-key end_of_turn \
  --label-key continuation \
  --split random --seed 42 --ratios 0.8,0.1,0.1

wk exports download <export-id> --out ./snapshots/smart-turn-zh
wk exports adapt smart-turn \
  --export-dir ./snapshots/smart-turn-zh \
  --out ./datasets/smart-turn-zh \
  --language zh
```

The notebooks default to `../../datasets/smart-turn-zh` relative to
this directory — override `EXPORT_DIR` in the first code cell if your
output landed elsewhere.
