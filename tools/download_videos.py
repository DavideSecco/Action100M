import argparse
import os
import shutil
import subprocess
import sys

import pyarrow.parquet as pq


def already_downloaded(uid: str, output_dir: str) -> bool:
    for fname in os.listdir(output_dir):
        if fname.startswith(uid + "."):
            return True
    return False


def download_video(uid: str, output_dir: str, fmt: str) -> str:
    url = f"https://www.youtube.com/watch?v={uid}"
    output_tmpl = os.path.join(output_dir, f"{uid}.%(ext)s")
    result = subprocess.run(
        ["yt-dlp", "-f", fmt, "--merge-output-format", "mp4", "-o", output_tmpl, url],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return f"ERRORE: {result.stderr.strip().splitlines()[-1] if result.stderr.strip() else 'unknown error'}"
    return "OK"


def main():
    parser = argparse.ArgumentParser(description="Scarica i video di un file .parquet tramite yt-dlp.")
    parser.add_argument("parquet_file", help="Path al file .parquet")
    parser.add_argument("--output-dir", default="./data/videos", help="Cartella di destinazione (default: ./data/videos)")
    parser.add_argument("--format", default="bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best", dest="fmt", help="Formato yt-dlp")
    parser.add_argument("--max-videos", type=int, default=None, help="Numero massimo di video da scaricare")
    parser.add_argument("--force", action="store_true", help="Riscarica i video già presenti")
    args = parser.parse_args()

    if shutil.which("yt-dlp") is None:
        print("Errore: yt-dlp non trovato. Installalo con: pip install yt-dlp", file=sys.stderr)
        sys.exit(1)
    if shutil.which("ffmpeg") is None:
        print("Attenzione: ffmpeg non trovato. Il merging audio+video non funzionerà.", file=sys.stderr)
        print("Installa ffmpeg (es: sudo apt install ffmpeg) per scaricare video con audio.", file=sys.stderr)

    parquet_stem = os.path.splitext(os.path.basename(args.parquet_file))[0]
    output_dir = os.path.join(args.output_dir, parquet_stem)

    table = pq.read_table(args.parquet_file, columns=["video_uid", "metadata", "nodes"])
    rows = table.to_pydict()
    uids = rows["video_uid"]

    os.makedirs(output_dir, exist_ok=True)

    # --- riepilogo iniziale ---
    total_in_file = len(uids)
    if args.max_videos is not None:
        uids = uids[: args.max_videos]
        rows["metadata"] = rows["metadata"][: args.max_videos]
        rows["nodes"] = rows["nodes"][: args.max_videos]

    total_duration = sum(r.get("duration") or 0 for r in rows["metadata"])
    video_count_str = str(len(uids))
    if args.max_videos is not None:
        video_count_str += f"  (di {total_in_file} totali nel file)"
    print(f"\nFile:    {args.parquet_file}")
    print(f"Output:  {output_dir}")
    print(f"Video:   {video_count_str}")
    print(f"Durata totale: {total_duration // 3600}h {(total_duration % 3600) // 60}m {total_duration % 60}s")
    print()
    print(f"{'#':<4} {'video_uid':<14} {'dur':>6}  {'nodi':>5}  {'views':>7}  titolo")
    print("-" * 80)
    for i, (uid, meta, nodes) in enumerate(zip(uids, rows["metadata"], rows["nodes"]), 1):
        dur = meta.get("duration") or 0
        views = meta.get("view_count") or 0
        title = (meta.get("title") or "")[:42]
        status = "✓" if already_downloaded(uid, output_dir) else " "
        print(f"{i:<4} {uid:<14} {dur:>5}s  {len(nodes):>5}  {views:>7,}  {title}  {status}")
    print("-" * 80)
    print()

    # --- download ---
    downloaded = skipped = failed = 0
    for i, (uid, meta) in enumerate(zip(uids, rows["metadata"]), 1):
        title = (meta.get("title") or "")[:50]
        dur = meta.get("duration") or 0
        prefix = f"[{i}/{len(uids)}] {uid}  ({dur}s)  {title!r}"
        if already_downloaded(uid, output_dir) and not args.force:
            print(f"{prefix}\n  → già presente, skip")
            skipped += 1
            continue
        print(f"{prefix}\n  → download...")
        status = download_video(uid, output_dir, args.fmt)
        if status == "OK":
            print(f"  → scaricato")
            downloaded += 1
        else:
            print(f"  → {status}")
            failed += 1

    print(f"\nRiepilogo: {downloaded} scaricati, {skipped} skippati, {failed} falliti")


if __name__ == "__main__":
    main()
