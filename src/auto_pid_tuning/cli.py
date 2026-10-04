"""Command line entry point: `auto-pid-tuning LOG --style freestyle`."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .analysis import analyze
from .blackbox import LogError, load_log, log_count
from .report import to_dict, to_text
from .styles import STYLES, get_style
from .tuner import tune


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="auto-pid-tuning",
        description="Suggest Betaflight PIDs, filters and rates from a blackbox log.",
    )
    parser.add_argument("log", type=Path, help="blackbox log file (.bbl / .bfl)")
    parser.add_argument(
        "-s",
        "--style",
        default="freestyle",
        help=f"flight style: {', '.join(STYLES)} (default: freestyle)",
    )
    parser.add_argument(
        "-i",
        "--log-index",
        type=int,
        help="flight to analyse when the file holds several (1-based, default: the last one)",
    )
    parser.add_argument("--json", action="store_true", help="print the full result as JSON")
    parser.add_argument("-o", "--output", type=Path, help="write the CLI commands to this file")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        style = get_style(args.style)
        count = log_count(args.log) if args.log.is_file() else 1
        index = args.log_index or count
        if not 1 <= index <= count:
            raise LogError(f"--log-index must be between 1 and {count} for this file.")
        log = load_log(args.log, index)
    except (LogError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    analysis = analyze(log)
    result = tune(log.headers, analysis, style)

    if args.json:
        print(json.dumps(to_dict(log.headers, analysis, result), indent=2))
    else:
        if count > 1:
            print(f"Flight {index} of {count} in {args.log.name}\n")
        print(to_text(log.headers, analysis, result))
    if args.output:
        args.output.write_text("\n".join(result.cli_commands()) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
