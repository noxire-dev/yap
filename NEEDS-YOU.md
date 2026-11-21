# Needs you (bench v1, 2026-11-21)

- Publish or not. The results are in `bench/results/2026-11-21.md`, with raw rows in `2026-11-21.json`. The
  mirako.computer/yap.html update waits on you; nothing was published.
- Plan usage, for the record: the dry run cost $1.90 and moved weekly usage by under 1 point, so the full run was
  projected at under 18% of a week. It cost $50.61 API-equivalent, and weekly usage went 32% → 34% while bench v2
  ran alongside. Nothing is blocked.
- One product call: `yap gate` asks for a yes on the desktop, so a crew set up from a script (the bench's E) stops
  on a dialog. The bench uses `YAP_YOLO=1` on its throwaway daemons. Should `yap gate` take the gate without a
  dialog when it comes from the same user's CLI? Board #67.
