# Vendored packages

`orangebox-0.5.0-py3-none-any.whl` is the PyPI wheel of [orangebox](https://github.com/atomgomba/orangebox)
(GPL-3.0, licence inside the wheel) with only `entry_points.txt` removed. The original declares its
command-line scripts as `scripts/bb2csv`, which is not a valid entry point, and uv refuses to
install it on Linux (CI, Docker). The library code is untouched. Drop this once a fixed release
is on PyPI.
