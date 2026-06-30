from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from itertools import combinations
from pathlib import Path
from statistics import mean, stdev
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[2]

WINDOWS = [
    {"key": "1m", "label": "近一月", "months": 1, "min_days": 25},
    {"key": "3m", "label": "近三月", "months": 3, "min_days": 75},
    {"key": "6m", "label": "近六月", "months": 6, "min_days": 150},
    {"key": "1y", "label": "近一年", "years": 1, "min_days": 300},
    {"key": "3y", "label": "近三年", "years": 3, "min_days": 900},
    {"key": "5y", "label": "近五年", "years": 5, "min_days": 1500},
]

DIMENSIONS = [
    {"key": "primaryStrategy", "label": "一级策略"},
    {"key": "secondaryStrategy", "label": "二级策略"},
]

FIELD_LABELS = {
    "name": "产品名称",
    "url": "产品链接",
    "primaryStrategy": "一级策略",
    "secondaryStrategy": "二级策略",
    "strategyTags": "策略标签",
    "inceptionDate": "成立日期",
    "operationStatus": "运行状态",
    "privateManager": "私募管理人",
    "companyManagementScale": "管理规模",
    "fundManager": "基金经理",
    "recordNumber": "备案编号",
    "latestDate": "最新净值日期",
    "latestUnitNetValue": "最新单位净值",
    "latestAccumulatedNetValue": "最新累计净值",
    "latestRestoredNetValue": "最新复权净值",
    "latestChangeRate": "近一期涨跌幅",
    "sampleCount": "净值样本数",
    "coverageYears": "净值覆盖年限",
    "staleDays": "最新净值距今天数",
}

METRIC_LABELS = {
    "totalReturn": "区间收益",
    "annualReturn": "年化收益",
    "annualVolatility": "年化波动",
    "maxDrawdown": "最大回撤",
    "sharpe": "夏普比率",
    "calmar": "卡玛比率",
    "currentDrawdown": "当前回撤",
    "returnDrawdownRatio": "收益回撤比",
    "positiveRate": "正收益占比",
    "worstPeriodReturn": "最大单期亏损",
    "sampleCount": "区间样本数",
    "startDate": "区间开始",
    "endDate": "区间结束",
}

METRIC_COLUMNS = [
    "annualReturn",
    "annualVolatility",
    "maxDrawdown",
    "sharpe",
    "calmar",
    "totalReturn",
    "positiveRate",
    "sampleCount",
]

@dataclass(slots=True)
class Point:
    date: str
    value: float
    day: int

    @property
    def parsed_date(self) -> date:
        return date.fromordinal(self.day)


def make_point(date_text: str, value: float) -> Point:
    parsed = parse_date(date_text)
    return Point(date_text, value, parsed.toordinal())


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze fof99 net values and generate local HTML reports.")
    parser.add_argument("--input", default="output/fof99-net-values/net-values.csv")
    parser.add_argument("--input-dir", default="output/fof99-net-values")
    parser.add_argument("--output-dir", default="output/fof99-analysis")
    parser.add_argument("--source", choices=["auto", "json", "csv"], default="auto")
    parser.add_argument("--list-benchmarks", action="store_true")
    parser.add_argument("--skip-benchmarks", action="store_true")
    parser.add_argument("--include-series-json", action="store_true")
    parser.add_argument("--min-benchmark-products", type=int, default=2)
    parser.add_argument("--min-product-samples", type=int, default=2)
    parser.add_argument("--json-workers", type=int, default=1)
    parser.add_argument("--today", default=date.today().isoformat())
    args = parser.parse_args()

    input_csv = resolve_path(args.input)
    input_dir = resolve_path(args.input_dir)
    output_dir = resolve_path(args.output_dir)
    today = parse_date(args.today)

    json_files = list_product_json_files(input_dir) if input_dir.exists() else []
    use_json = args.source == "json" or (args.source == "auto" and json_files)
    if use_json and not json_files:
        raise FileNotFoundError(f"No platform-net-values.json found under: {input_dir}")
    if not use_json and not input_csv.exists():
        raise FileNotFoundError(f"Input CSV not found: {input_csv}")

    if args.list_benchmarks:
        names = list_benchmark_names_from_json_files(json_files, max(1, args.min_benchmark_products)) if use_json else list_benchmark_names_from_rows(read_csv(input_csv), max(1, args.min_benchmark_products))
        print(f"[fof99:analyze] benchmarkCount={len(names)}")
        for name in names:
            print(name)
        return

    output_dir.mkdir(parents=True, exist_ok=True)

    started_at = time.perf_counter()
    print(f"[fof99:analyze] source={'json' if use_json else 'csv'}", flush=True)
    if use_json:
        print(f"[fof99:analyze] jsonFiles={len(json_files)}", flush=True)
    products = build_products_from_json_files(json_files, today, max(1, args.min_product_samples), max(1, args.json_workers)) if use_json else build_products(read_csv(input_csv), today, max(1, args.min_product_samples))
    print(f"[fof99:analyze] productsReady={len(products)} elapsed={time.perf_counter() - started_at:.1f}s", flush=True)
    benchmarks = [] if args.skip_benchmarks else build_benchmarks(products, max(1, args.min_benchmark_products))
    if args.skip_benchmarks:
        print(f"[fof99:analyze] benchmarksSkipped=true elapsed={time.perf_counter() - started_at:.1f}s", flush=True)
    else:
        print(f"[fof99:analyze] benchmarksReady={len(benchmarks)} elapsed={time.perf_counter() - started_at:.1f}s", flush=True)

    write_csv(output_dir / "products.csv", product_rows(products))
    write_csv(output_dir / "benchmarks.csv", benchmark_rows(benchmarks))
    write_json(output_dir / "products.json", strip_internal_product_fields(products, keep_series=args.include_series_json))
    write_json(output_dir / "benchmarks.json", benchmarks)
    (output_dir / "index.html").write_text(render_html(products, benchmarks), encoding="utf-8")

    print(f"[fof99:analyze] products={len(products)}")
    print(f"[fof99:analyze] benchmarks={len(benchmarks)}")
    print(f"[fof99:analyze] html={output_dir / 'index.html'}")


def build_products(rows: list[dict[str, str]], today: date, min_product_samples: int = 2) -> list[dict[str, Any]]:
    products_by_url: dict[str, dict[str, Any]] = {}

    for row in rows:
        ingest_product_row(products_by_url, row)

    return finalize_products(products_by_url, today, min_product_samples)


def list_benchmark_names_from_rows(rows: list[dict[str, str]], min_benchmark_products: int) -> list[str]:
    product_groups: dict[str, dict[str, str]] = {}
    for row in rows:
        product_key = clean(row.get("productUrl")) or clean(row.get("productName"))
        if not product_key:
            continue
        product_groups[product_key] = {
            "primaryStrategy": clean(row.get("primaryStrategy")),
            "secondaryStrategy": clean(row.get("secondaryStrategy")),
        }
    return benchmark_names_from_metadata(list(product_groups.values()), min_benchmark_products)


def list_benchmark_names_from_json_files(paths: list[Path], min_benchmark_products: int) -> list[str]:
    metadata_rows = []
    worker_count = min(32, max(4, (os.cpu_count() or 4) * 4))
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        for metadata in executor.map(extract_metadata_quick, paths, chunksize=128):
            if metadata:
                metadata_rows.append(metadata)
    return benchmark_names_from_metadata(metadata_rows, min_benchmark_products)


def benchmark_names_from_metadata(metadata_rows: list[dict[str, str]], min_benchmark_products: int) -> list[str]:
    groups: dict[tuple[str, str], int] = defaultdict(int)
    dimension_keys = [dimension["key"] for dimension in DIMENSIONS]

    for metadata in metadata_rows:
        for combo in all_dimension_combinations(dimension_keys):
            values = [normalize_group_value(metadata.get(key)) for key in combo]
            group_key = " / ".join(values)
            dimension_label = " + ".join(label_for_dimension(key) for key in combo)
            groups[(dimension_label, group_key)] += 1

    names = []
    for (dimension_label, group_key), count in groups.items():
        if count >= min_benchmark_products:
            names.append(f"{dimension_label}: {group_key}")
    return sorted(names)


def extract_metadata_quick(path: Path) -> dict[str, str] | None:
    try:
        with path.open("r", encoding="utf-8") as file:
            text = file.read(4096)
    except OSError:
        return None

    primary = extract_json_string_field(text, "primaryStrategy")
    secondary = extract_json_string_field(text, "secondaryStrategy")
    if primary is None and secondary is None:
        try:
            with path.open("r", encoding="utf-8") as file:
                text = file.read(32768)
        except OSError:
            return None
        primary = extract_json_string_field(text, "primaryStrategy")
        secondary = extract_json_string_field(text, "secondaryStrategy")
    if primary is None and secondary is None:
        return None
    return {
        "primaryStrategy": primary or "",
        "secondaryStrategy": secondary or "",
    }


def extract_json_string_field(text: str, key: str) -> str | None:
    match = re.search(rf'"{re.escape(key)}"\s*:\s*"((?:\\.|[^"\\])*)"', text)
    if not match:
        return None
    try:
        return clean(json.loads(f'"{match.group(1)}"'))
    except json.JSONDecodeError:
        return clean(match.group(1))


def list_product_json_files(input_dir: Path) -> list[Path]:
    paths: list[Path] = []
    try:
        with os.scandir(input_dir) as entries:
            for entry in entries:
                if not entry.is_dir(follow_symlinks=False):
                    continue
                candidate = Path(entry.path) / "platform-net-values.json"
                if candidate.exists():
                    paths.append(candidate)
    except OSError:
        return []
    return paths


def build_products_from_json_files(paths: list[Path], today: date, min_product_samples: int = 2, json_workers: int = 1) -> list[dict[str, Any]]:
    if json_workers <= 1:
        return build_products_from_json_files_legacy(paths, today, min_product_samples)

    products_by_url: dict[str, dict[str, Any]] = {}
    started_at = time.perf_counter()
    worker_count = min(32, max(4, (os.cpu_count() or 4) * 4))
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        product_iter = executor.map(read_product_from_json_file, paths, chunksize=64)
        for index, product in enumerate(product_iter, start=1):
            if index % 5000 == 0:
                print(
                    f"[fof99:analyze] readJson={index}/{len(paths)} products={len(products_by_url)} elapsed={time.perf_counter() - started_at:.1f}s",
                    flush=True,
                )
            if not product:
                continue
            merge_product(products_by_url, product)

    return finalize_products(products_by_url, today, min_product_samples)


def read_product_from_json_file(path: Path) -> dict[str, Any] | None:
    try:
        if path.stat().st_size < 700:
            return None
    except OSError:
        return None

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    product = payload.get("product") if isinstance(payload.get("product"), dict) else {}
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    product_rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
    if not product_rows:
        return None

    product_name = clean(product.get("name")) or path.parent.name
    product_url = clean(product.get("url")) or clean(payload.get("detailUrl"))
    base_row = {
        "productName": product_name,
        "productUrl": product_url,
        "primaryStrategy": clean(metadata.get("primaryStrategy")),
        "secondaryStrategy": clean(metadata.get("secondaryStrategy")),
        "strategyTags": clean(metadata.get("strategyTags")),
        "operationStatus": clean(metadata.get("operationStatus")),
        "recordNumber": clean(metadata.get("recordNumber")),
        "inceptionDate": clean(metadata.get("inceptionDate")),
        "privateManager": clean(metadata.get("privateManager")),
        "companyManagementScale": clean(metadata.get("companyManagementScale")),
        "fundManager": clean(metadata.get("fundManager")),
    }

    local_products: dict[str, dict[str, Any]] = {}
    for item in product_rows:
        if not isinstance(item, dict):
            continue
        ingest_product_row(
            local_products,
            {
                **base_row,
                "date": clean(item.get("date")),
                "unitNetValue": clean(item.get("unitNetValue")),
                "accumulatedNetValue": clean(item.get("accumulatedNetValue")),
                "restoredNetValue": clean(item.get("restoredNetValue")),
                "changeRate": clean(item.get("changeRate")),
            },
        )

    if not local_products:
        return None
    return next(iter(local_products.values()))


def merge_product(products_by_url: dict[str, dict[str, Any]], incoming: dict[str, Any]) -> None:
    url = incoming.get("url")
    if not url:
        return
    if url not in products_by_url:
        products_by_url[url] = incoming
        return

    existing = products_by_url[url]
    for key, value in incoming.items():
        if key == "_series_by_date":
            for date_key, point in value.items():
                old_point = existing["_series_by_date"].get(date_key)
                if not old_point or point.get("preference", 0) > old_point.get("preference", 0):
                    existing["_series_by_date"][date_key] = point
        elif value and not existing.get(key):
            existing[key] = value


def build_products_from_json_files_legacy(paths: list[Path], today: date, min_product_samples: int = 2) -> list[dict[str, Any]]:
    products_by_url: dict[str, dict[str, Any]] = {}
    started_at = time.perf_counter()
    for index, path in enumerate(paths, start=1):
        if index % 5000 == 0:
            print(
                f"[fof99:analyze] readJson={index}/{len(paths)} products={len(products_by_url)} elapsed={time.perf_counter() - started_at:.1f}s",
                flush=True,
            )
        if path.stat().st_size < 700:
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        product = payload.get("product") if isinstance(payload.get("product"), dict) else {}
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        product_rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
        if not product_rows:
            continue

        product_name = clean(product.get("name")) or path.parent.name
        product_url = clean(product.get("url")) or clean(payload.get("detailUrl"))
        base_row = {
            "productName": product_name,
            "productUrl": product_url,
            "primaryStrategy": clean(metadata.get("primaryStrategy")),
            "secondaryStrategy": clean(metadata.get("secondaryStrategy")),
            "strategyTags": clean(metadata.get("strategyTags")),
            "operationStatus": clean(metadata.get("operationStatus")),
            "recordNumber": clean(metadata.get("recordNumber")),
            "inceptionDate": clean(metadata.get("inceptionDate")),
            "privateManager": clean(metadata.get("privateManager")),
            "companyManagementScale": clean(metadata.get("companyManagementScale")),
            "fundManager": clean(metadata.get("fundManager")),
        }
        for item in product_rows:
            if not isinstance(item, dict):
                continue
            ingest_product_row(
                products_by_url,
                {
                    **base_row,
                    "date": clean(item.get("date")),
                    "unitNetValue": clean(item.get("unitNetValue")),
                    "accumulatedNetValue": clean(item.get("accumulatedNetValue")),
                    "restoredNetValue": clean(item.get("restoredNetValue")),
                    "changeRate": clean(item.get("changeRate")),
                },
            )

    return finalize_products(products_by_url, today, min_product_samples)


def ingest_product_row(products_by_url: dict[str, dict[str, Any]], row: dict[str, str]) -> None:
    url = clean(row.get("productUrl"))
    name = clean(row.get("productName"))
    row_date = parse_date_or_none(row.get("date"))
    value = first_finite_number(row.get("restoredNetValue"), row.get("accumulatedNetValue"), row.get("unitNetValue"))
    if not url or not name or not row_date or not math.isfinite(value) or value <= 0:
        return

    if url not in products_by_url:
        products_by_url[url] = {
            "id": url,
            "name": name,
            "url": url,
            "primaryStrategy": clean(row.get("primaryStrategy")),
            "secondaryStrategy": clean(row.get("secondaryStrategy")),
            "strategyTags": clean(row.get("strategyTags")),
            "operationStatus": clean(row.get("operationStatus")),
            "recordNumber": clean(row.get("recordNumber")),
            "inceptionDate": clean(row.get("inceptionDate")),
            "privateManager": clean(row.get("privateManager")),
            "companyManagementScale": clean(row.get("companyManagementScale")),
            "fundManager": clean(row.get("fundManager")),
            "latestUnitNetValue": "",
            "latestAccumulatedNetValue": "",
            "latestRestoredNetValue": "",
            "latestChangeRate": "",
            "_series_by_date": {},
        }

    product = products_by_url[url]
    merge_text_fields(product, row)
    date_key = row_date.isoformat()
    candidate = {
        "date": date_key,
        "value": value,
        "unitNetValue": clean(row.get("unitNetValue")),
        "accumulatedNetValue": clean(row.get("accumulatedNetValue")),
        "restoredNetValue": clean(row.get("restoredNetValue")),
        "changeRate": clean(row.get("changeRate")),
        "preference": value_preference(row),
    }
    existing = product["_series_by_date"].get(date_key)
    if not existing or candidate["preference"] > existing["preference"]:
        product["_series_by_date"][date_key] = candidate


def finalize_products(products_by_url: dict[str, dict[str, Any]], today: date, min_product_samples: int = 2) -> list[dict[str, Any]]:
    products: list[dict[str, Any]] = []
    started_at = time.perf_counter()
    total = len(products_by_url)
    for index, product in enumerate(products_by_url.values(), start=1):
        if index % 5000 == 0:
            print(
                f"[fof99:analyze] finalizeProducts={index}/{total} kept={len(products)} elapsed={time.perf_counter() - started_at:.1f}s",
                flush=True,
            )
        raw_series = sorted(product["_series_by_date"].values(), key=lambda item: item["date"])
        if len(raw_series) < min_product_samples:
            continue

        first = raw_series[0]
        latest = raw_series[-1]
        series = [make_point(item["date"], item["value"]) for item in raw_series]
        first_date = parse_date(first["date"])
        latest_date = parse_date(latest["date"])

        product["series"] = [{"date": point.date, "value": round_number(point.value, 8)} for point in series]
        product["_returnSeries"] = compute_return_series(series)
        product["latestDate"] = latest["date"]
        product["latestUnitNetValue"] = latest["unitNetValue"]
        product["latestAccumulatedNetValue"] = latest["accumulatedNetValue"]
        product["latestRestoredNetValue"] = latest["restoredNetValue"]
        product["latestChangeRate"] = latest["changeRate"]
        product["sampleCount"] = len(series)
        product["coverageYears"] = round_number((latest_date - first_date).days / 365, 2)
        product["staleDays"] = max(0, (today - latest_date).days)
        product["metrics"] = compute_all_window_metrics(series)
        product["availableWindows"] = list(product["metrics"].keys())
        del product["_series_by_date"]
        products.append(product)

    return sorted(products, key=lambda item: item["name"])


def build_benchmarks(products: list[dict[str, Any]], min_benchmark_products: int) -> list[dict[str, Any]]:
    dimension_keys = [dimension["key"] for dimension in DIMENSIONS]
    benchmarks: list[dict[str, Any]] = []

    for combo in all_dimension_combinations(dimension_keys):
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for product in products:
            values = [normalize_group_value(product.get(key)) for key in combo]
            groups[" / ".join(values)].append(product)

        for group_key, group_products in groups.items():
            if len(group_products) < min_benchmark_products:
                continue
            series = compute_benchmark_series(group_products)
            if len(series) < 2:
                continue
            metrics = compute_all_window_metrics(series)
            if not metrics:
                continue
            group_values = group_key.split(" / ")
            benchmarks.append(
                {
                    "id": f"{'+'.join(combo)}::{group_key}",
                    "dimensionKeys": combo,
                    "dimensionLabel": " + ".join(label_for_dimension(key) for key in combo),
                    "groupKey": group_key,
                    "values": {key: group_values[index] for index, key in enumerate(combo)},
                    "productCount": len(group_products),
                    "sampleCount": len(series),
                    "startDate": series[0].date,
                    "endDate": series[-1].date,
                    "metrics": metrics,
                    "availableWindows": list(metrics.keys()),
                }
            )

    return sorted(benchmarks, key=lambda item: (item["dimensionLabel"], item["groupKey"]))


def compute_benchmark_series(products: list[dict[str, Any]]) -> list[Point]:
    returns_by_date: dict[str, list[float]] = defaultdict(list)

    for product in products:
        for item in product.get("_returnSeries", []):
            returns_by_date[item["date"]].append(item["return"])

    index_value = 1.0
    benchmark_series: list[Point] = []
    for date_key in sorted(returns_by_date):
        period_return = mean(returns_by_date[date_key])
        index_value *= 1 + period_return
        benchmark_series.append(make_point(date_key, round_number(index_value, 8)))
    return benchmark_series


def compute_return_series(series: list[Point]) -> list[dict[str, float | str]]:
    returns = []
    for previous, current in zip(series, series[1:]):
        if previous.value <= 0 or current.value <= 0:
            continue
        period_return = current.value / previous.value - 1
        if math.isfinite(period_return):
            returns.append({"date": current.date, "return": period_return})
    return returns


def compute_all_window_metrics(series: list[Point]) -> dict[str, dict[str, Any]]:
    metrics = {}
    for window in WINDOWS:
        window_metrics = compute_window_metrics(series, window)
        if window_metrics:
            metrics[window["key"]] = window_metrics
    return metrics


def compute_window_metrics(series: list[Point], window: dict[str, Any]) -> dict[str, Any] | None:
    if len(series) < 2:
        return None

    latest = series[-1]
    target_start = shift_date(latest.parsed_date, months=window.get("months", 0), years=window.get("years", 0))
    target_day = target_start.toordinal()
    if series[0].day > target_day:
        return None

    start_index = 0
    for index, point in enumerate(series):
        if point.day <= target_day:
            start_index = index
        else:
            break

    window_series = series[start_index:]
    if len(window_series) < 2:
        return None

    start = window_series[0]
    end = window_series[-1]
    days = max(1, end.day - start.day)
    if days < window["min_days"]:
        return None

    returns = []
    for previous, current in zip(window_series, window_series[1:]):
        if previous.value > 0 and current.value > 0:
            returns.append(current.value / previous.value - 1)
    if not returns:
        return None

    years = days / 365
    total_return = end.value / start.value - 1
    annual_return = (end.value / start.value) ** (1 / years) - 1
    annual_volatility = (stdev(returns) if len(returns) >= 2 else 0) * math.sqrt(len(returns) / years)
    max_drawdown = compute_max_drawdown(window_series)
    current_drawdown = compute_current_drawdown(window_series)
    positive_rate = len([value for value in returns if value > 0]) / len(returns)
    worst_period_return = min(returns)

    return {
        "startDate": start.date,
        "endDate": end.date,
        "sampleCount": len(window_series),
        "totalReturn": round_nullable(total_return, 6),
        "annualReturn": round_nullable(annual_return, 6),
        "annualVolatility": round_nullable(annual_volatility, 6),
        "maxDrawdown": round_nullable(max_drawdown, 6),
        "sharpe": round_nullable(safe_ratio(annual_return, annual_volatility), 4),
        "calmar": round_nullable(safe_ratio(annual_return, abs(max_drawdown)), 4),
        "currentDrawdown": round_nullable(current_drawdown, 6),
        "returnDrawdownRatio": round_nullable(safe_ratio(total_return, abs(max_drawdown)), 4),
        "positiveRate": round_nullable(positive_rate, 6),
        "worstPeriodReturn": round_nullable(worst_period_return, 6),
    }


def product_rows(products: list[dict[str, Any]]) -> list[list[Any]]:
    rows = [
        [
            "产品名称",
            "产品链接",
            "一级策略",
            "二级策略",
            "运行状态",
            "私募管理人",
            "管理规模",
            "成立日期",
            "最新净值日期",
            "净值样本数",
            "净值覆盖年限",
            "最新净值距今天数",
            *metric_csv_headers(),
        ]
    ]
    for product in products:
        rows.append(
            [
                product.get("name", ""),
                product.get("url", ""),
                product.get("primaryStrategy", ""),
                product.get("secondaryStrategy", ""),
                product.get("operationStatus", ""),
                product.get("privateManager", ""),
                product.get("companyManagementScale", ""),
                product.get("inceptionDate", ""),
                product.get("latestDate", ""),
                product.get("sampleCount", ""),
                product.get("coverageYears", ""),
                product.get("staleDays", ""),
                *metric_csv_values(product.get("metrics", {})),
            ]
        )
    return rows


def benchmark_rows(benchmarks: list[dict[str, Any]]) -> list[list[Any]]:
    rows = [["聚合维度", "分组", "产品数", "指数开始日期", "指数结束日期", "指数样本数", *metric_csv_headers()]]
    for benchmark in benchmarks:
        rows.append(
            [
                benchmark.get("dimensionLabel", ""),
                benchmark.get("groupKey", ""),
                benchmark.get("productCount", ""),
                benchmark.get("startDate", ""),
                benchmark.get("endDate", ""),
                benchmark.get("sampleCount", ""),
                *metric_csv_values(benchmark.get("metrics", {})),
            ]
        )
    return rows


def strip_internal_product_fields(products: list[dict[str, Any]], keep_series: bool) -> list[dict[str, Any]]:
    stripped = []
    for product in products:
        item = {}
        for key, value in product.items():
            if key.startswith("_"):
                continue
            if key == "series" and not keep_series:
                continue
            item[key] = value
        stripped.append(item)
    return stripped


def metric_csv_headers() -> list[str]:
    return [f"{window['label']}{METRIC_LABELS[metric]}" for window in WINDOWS for metric in METRIC_COLUMNS]


def metric_csv_values(metrics: dict[str, Any]) -> list[Any]:
    return [metrics.get(window["key"], {}).get(metric, "") for window in WINDOWS for metric in METRIC_COLUMNS]


def render_html(products: list[dict[str, Any]], benchmarks: list[dict[str, Any]]) -> str:
    html_products = strip_internal_product_fields(products, keep_series=False)
    data = json.dumps(
        {
            "products": html_products,
            "benchmarks": benchmarks,
            "windows": WINDOWS,
            "dimensions": DIMENSIONS,
            "fieldLabels": FIELD_LABELS,
            "metricLabels": METRIC_LABELS,
            "generatedAt": datetime.now().isoformat(),
        },
        ensure_ascii=False,
    ).replace("<", "\\u003c")

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FOF 私募策略分析</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #1d2433;
      --muted: #697386;
      --line: #d9dee8;
      --accent: #146a5d;
      --accent-soft: #e4f2ef;
      --bad: #b42318;
      --good: #067647;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", Arial, sans-serif;
      font-size: 14px;
    }}
    header {{
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
    }}
    .shell {{ width: min(1680px, calc(100vw - 32px)); margin: 0 auto; }}
    .topbar {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 64px;
    }}
    h1 {{ font-size: 20px; margin: 0; letter-spacing: 0; }}
    .subtle {{ color: var(--muted); font-size: 12px; }}
    .tabs {{ display: flex; gap: 6px; align-items: center; }}
    .tab {{
      border: 1px solid var(--line);
      background: #fff;
      color: var(--text);
      border-radius: 6px;
      padding: 8px 12px;
      cursor: pointer;
    }}
    .tab.active {{ background: var(--accent); color: #fff; border-color: var(--accent); }}
    main {{ padding: 18px 0 40px; }}
    .summary {{
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }}
    .summary-item {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
    }}
    .summary-value {{ font-size: 22px; font-weight: 700; }}
    .summary-label {{ color: var(--muted); margin-top: 2px; }}
    .controls {{
      display: grid;
      grid-template-columns: repeat(6, minmax(120px, 1fr));
      gap: 10px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 14px;
    }}
    label {{ display: grid; gap: 5px; color: var(--muted); font-size: 12px; min-width: 0; }}
    input, select {{
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 9px;
      background: #fff;
      color: var(--text);
      font: inherit;
      min-height: 36px;
    }}
    .table-tools {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }}
    .pager {{ display: flex; align-items: center; gap: 8px; color: var(--muted); }}
    button {{
      border: 1px solid var(--line);
      background: #fff;
      color: var(--text);
      border-radius: 6px;
      min-height: 34px;
      padding: 7px 10px;
      cursor: pointer;
    }}
    button:disabled {{ opacity: .45; cursor: not-allowed; }}
    .table-wrap {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: auto;
      max-height: calc(100vh - 300px);
    }}
    table {{ border-collapse: separate; border-spacing: 0; width: 100%; min-width: 1320px; }}
    th, td {{
      border-bottom: 1px solid var(--line);
      padding: 9px 10px;
      text-align: left;
      white-space: nowrap;
      vertical-align: middle;
    }}
    th {{
      position: sticky;
      top: 0;
      z-index: 2;
      background: #eef2f6;
      font-weight: 700;
      cursor: pointer;
      user-select: none;
    }}
    tr:hover td {{ background: #f8fafc; }}
    .name-cell {{ min-width: 220px; max-width: 360px; white-space: normal; line-height: 1.35; }}
    .link {{ color: var(--accent); text-decoration: none; }}
    .metric-good {{ color: var(--good); font-weight: 650; }}
    .metric-bad {{ color: var(--bad); font-weight: 650; }}
    .badge {{
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 3px 8px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
    }}
    .hidden {{ display: none; }}
    @media (max-width: 1100px) {{
      .summary {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }}
      .controls {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }}
      .topbar {{ align-items: flex-start; flex-direction: column; padding: 12px 0; }}
    }}
  </style>
</head>
<body>
  <header>
    <div class="shell topbar">
      <div>
        <h1>FOF 私募策略分析</h1>
        <div class="subtle" id="generatedAt"></div>
      </div>
      <div class="tabs">
        <button class="tab active" data-tab="products">产品分析</button>
        <button class="tab" data-tab="benchmarks">Benchmark</button>
      </div>
    </div>
  </header>
  <main class="shell">
    <section class="summary">
      <div class="summary-item"><div class="summary-value" id="productCount">0</div><div class="summary-label">产品数量</div></div>
      <div class="summary-item"><div class="summary-value" id="benchmarkCount">0</div><div class="summary-label">Benchmark 数量</div></div>
      <div class="summary-item"><div class="summary-value" id="primaryCount">0</div><div class="summary-label">一级策略数</div></div>
      <div class="summary-item"><div class="summary-value" id="managerCount">0</div><div class="summary-label">私募管理人数</div></div>
    </section>

    <section id="productsPanel">
      <div class="controls">
        <label>搜索产品/管理人/策略<input id="productSearch" type="search" placeholder="输入关键词"></label>
        <label>时间窗口<select id="productWindow"></select></label>
        <label>一级策略<select id="primaryFilter"></select></label>
        <label>二级策略<select id="secondaryFilter"></select></label>
        <label>私募管理人<select id="managerFilter"></select></label>
        <label>管理规模<select id="scaleFilter"></select></label>
        <label>运行状态<select id="statusFilter"></select></label>
        <label>最少覆盖年限<input id="minYears" type="number" min="0" step="0.1" placeholder="不限"></label>
        <label>最少样本数<input id="minSamples" type="number" min="0" step="1" placeholder="不限"></label>
        <label>最新净值距今天数小于<input id="maxStaleDays" type="number" min="0" step="1" placeholder="不限"></label>
        <label>每页数量<select id="productPageSize"><option>50</option><option selected>100</option><option>200</option><option>500</option></select></label>
      </div>
      <div class="table-tools">
        <div class="subtle" id="productResultText"></div>
        <div class="pager">
          <button id="productPrev">上一页</button>
          <span id="productPageText"></span>
          <button id="productNext">下一页</button>
        </div>
      </div>
      <div class="table-wrap"><table id="productTable"></table></div>
    </section>

    <section id="benchmarksPanel" class="hidden">
      <div class="controls">
        <label>搜索分组<input id="benchmarkSearch" type="search" placeholder="输入关键词"></label>
        <label>时间窗口<select id="benchmarkWindow"></select></label>
        <label>聚合维度<select id="dimensionFilter"></select></label>
        <label>最少产品数<input id="minBenchmarkCount" type="number" min="1" step="1" placeholder="不限"></label>
        <label>每页数量<select id="benchmarkPageSize"><option>50</option><option selected>100</option><option>200</option><option>500</option></select></label>
      </div>
      <div class="table-tools">
        <div class="subtle" id="benchmarkResultText"></div>
        <div class="pager">
          <button id="benchmarkPrev">上一页</button>
          <span id="benchmarkPageText"></span>
          <button id="benchmarkNext">下一页</button>
        </div>
      </div>
      <div class="table-wrap"><table id="benchmarkTable"></table></div>
    </section>
  </main>
  <script>
    const DATA = {data};
    const state = {{
      activeTab: "products",
      productPage: 1,
      benchmarkPage: 1,
      productSort: {{ key: "annualReturn", direction: "desc", metric: true }},
      benchmarkSort: {{ key: "annualReturn", direction: "desc", metric: true }}
    }};

    const percentMetrics = new Set(["totalReturn", "annualReturn", "annualVolatility", "maxDrawdown", "currentDrawdown", "positiveRate", "worstPeriodReturn"]);
    const metricColumns = ["annualReturn", "annualVolatility", "maxDrawdown", "sharpe", "calmar", "totalReturn", "positiveRate", "sampleCount"];

    init();

    function init() {{
      document.getElementById("generatedAt").textContent = "生成时间：" + new Date(DATA.generatedAt).toLocaleString();
      document.getElementById("productCount").textContent = DATA.products.length.toLocaleString();
      document.getElementById("benchmarkCount").textContent = DATA.benchmarks.length.toLocaleString();
      document.getElementById("primaryCount").textContent = uniqueValues(DATA.products, "primaryStrategy").length.toLocaleString();
      document.getElementById("managerCount").textContent = uniqueValues(DATA.products, "privateManager").length.toLocaleString();
      fillWindowSelect("productWindow");
      fillWindowSelect("benchmarkWindow");
      fillSelect("primaryFilter", uniqueValues(DATA.products, "primaryStrategy"), "全部一级策略");
      fillSelect("secondaryFilter", uniqueValues(DATA.products, "secondaryStrategy"), "全部二级策略");
      fillSelect("managerFilter", uniqueValues(DATA.products, "privateManager"), "全部管理人");
      fillSelect("scaleFilter", uniqueValues(DATA.products, "companyManagementScale"), "全部管理规模");
      fillSelect("statusFilter", uniqueValues(DATA.products, "operationStatus"), "全部状态");
      fillSelect("dimensionFilter", uniqueValues(DATA.benchmarks, "dimensionLabel"), "全部聚合维度");
      document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
      bindInputs(["productSearch", "productWindow", "primaryFilter", "secondaryFilter", "managerFilter", "scaleFilter", "statusFilter", "minYears", "minSamples", "maxStaleDays", "productPageSize"], () => {{ state.productPage = 1; renderProducts(); }});
      bindInputs(["benchmarkSearch", "benchmarkWindow", "dimensionFilter", "minBenchmarkCount", "benchmarkPageSize"], () => {{ state.benchmarkPage = 1; renderBenchmarks(); }});
      document.getElementById("productPrev").addEventListener("click", () => {{ state.productPage -= 1; renderProducts(); }});
      document.getElementById("productNext").addEventListener("click", () => {{ state.productPage += 1; renderProducts(); }});
      document.getElementById("benchmarkPrev").addEventListener("click", () => {{ state.benchmarkPage -= 1; renderBenchmarks(); }});
      document.getElementById("benchmarkNext").addEventListener("click", () => {{ state.benchmarkPage += 1; renderBenchmarks(); }});
      renderProducts();
      renderBenchmarks();
    }}

    function switchTab(tab) {{
      state.activeTab = tab;
      document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
      document.getElementById("productsPanel").classList.toggle("hidden", tab !== "products");
      document.getElementById("benchmarksPanel").classList.toggle("hidden", tab !== "benchmarks");
    }}

    function renderProducts() {{
      const selectedWindow = valueOf("productWindow");
      const query = valueOf("productSearch").toLowerCase();
      const rows = DATA.products.filter((product) => {{
        if (valueOf("primaryFilter") && product.primaryStrategy !== valueOf("primaryFilter")) return false;
        if (valueOf("secondaryFilter") && product.secondaryStrategy !== valueOf("secondaryFilter")) return false;
        if (valueOf("managerFilter") && product.privateManager !== valueOf("managerFilter")) return false;
        if (valueOf("scaleFilter") && product.companyManagementScale !== valueOf("scaleFilter")) return false;
        if (valueOf("statusFilter") && product.operationStatus !== valueOf("statusFilter")) return false;
        if (numberOf("minYears") !== null && product.coverageYears < numberOf("minYears")) return false;
        if (numberOf("minSamples") !== null && product.sampleCount < numberOf("minSamples")) return false;
        if (numberOf("maxStaleDays") !== null && product.staleDays > numberOf("maxStaleDays")) return false;
        if (!query) return true;
        return [product.name, product.privateManager, product.primaryStrategy, product.secondaryStrategy, product.companyManagementScale].join(" ").toLowerCase().includes(query);
      }});
      sortRows(rows, state.productSort, selectedWindow);
      const pageSize = Number(valueOf("productPageSize") || 100);
      const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
      state.productPage = clamp(state.productPage, 1, pageCount);
      const pageRows = rows.slice((state.productPage - 1) * pageSize, state.productPage * pageSize);
      document.getElementById("productResultText").textContent = "当前显示 " + rows.length.toLocaleString() + " 个产品";
      document.getElementById("productPageText").textContent = state.productPage + " / " + pageCount;
      document.getElementById("productPrev").disabled = state.productPage <= 1;
      document.getElementById("productNext").disabled = state.productPage >= pageCount;
      const columns = [
        {{ key: "name", label: "产品名称" }},
        {{ key: "primaryStrategy", label: "一级策略" }},
        {{ key: "secondaryStrategy", label: "二级策略" }},
        {{ key: "privateManager", label: "私募管理人" }},
        {{ key: "companyManagementScale", label: "管理规模" }},
        {{ key: "operationStatus", label: "状态" }},
        {{ key: "latestDate", label: "最新净值" }},
        {{ key: "coverageYears", label: "覆盖年限" }},
        {{ key: "sampleCount", label: "样本数" }},
        {{ key: "staleDays", label: "距今天数" }},
        ...metricColumns.map((key) => ({{ key, label: DATA.metricLabels[key], metric: true }}))
      ];
      renderTable("productTable", columns, pageRows, selectedWindow, state.productSort, (row, column) => productCell(row, column, selectedWindow), renderProducts);
    }}

    function renderBenchmarks() {{
      const selectedWindow = valueOf("benchmarkWindow");
      const query = valueOf("benchmarkSearch").toLowerCase();
      const rows = DATA.benchmarks.filter((benchmark) => {{
        if (valueOf("dimensionFilter") && benchmark.dimensionLabel !== valueOf("dimensionFilter")) return false;
        if (numberOf("minBenchmarkCount") !== null && benchmark.productCount < numberOf("minBenchmarkCount")) return false;
        if (!query) return true;
        return [benchmark.dimensionLabel, benchmark.groupKey].join(" ").toLowerCase().includes(query);
      }});
      sortRows(rows, state.benchmarkSort, selectedWindow);
      const pageSize = Number(valueOf("benchmarkPageSize") || 100);
      const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
      state.benchmarkPage = clamp(state.benchmarkPage, 1, pageCount);
      const pageRows = rows.slice((state.benchmarkPage - 1) * pageSize, state.benchmarkPage * pageSize);
      document.getElementById("benchmarkResultText").textContent = "当前显示 " + rows.length.toLocaleString() + " 个 benchmark";
      document.getElementById("benchmarkPageText").textContent = state.benchmarkPage + " / " + pageCount;
      document.getElementById("benchmarkPrev").disabled = state.benchmarkPage <= 1;
      document.getElementById("benchmarkNext").disabled = state.benchmarkPage >= pageCount;
      const columns = [
        {{ key: "dimensionLabel", label: "聚合维度" }},
        {{ key: "groupKey", label: "分组" }},
        {{ key: "productCount", label: "产品数" }},
        {{ key: "startDate", label: "指数开始" }},
        {{ key: "endDate", label: "指数结束" }},
        {{ key: "sampleCount", label: "指数样本" }},
        ...metricColumns.map((key) => ({{ key, label: DATA.metricLabels[key], metric: true }}))
      ];
      renderTable("benchmarkTable", columns, pageRows, selectedWindow, state.benchmarkSort, (row, column) => benchmarkCell(row, column, selectedWindow), renderBenchmarks);
    }}

    function renderTable(tableId, columns, rows, selectedWindow, sortState, cellRenderer, rerender) {{
      const table = document.getElementById(tableId);
      const thead = "<thead><tr>" + columns.map((column) => {{
        const active = sortState.key === column.key && Boolean(sortState.metric) === Boolean(column.metric);
        const arrow = active ? (sortState.direction === "asc" ? " ▲" : " ▼") : "";
        return "<th data-key=\\"" + escapeHtml(column.key) + "\\" data-metric=\\"" + (column.metric ? "1" : "0") + "\\">" + escapeHtml(column.label + arrow) + "</th>";
      }}).join("") + "</tr></thead>";
      const tbody = "<tbody>" + rows.map((row) => "<tr>" + columns.map((column) => cellRenderer(row, column)).join("") + "</tr>").join("") + "</tbody>";
      table.innerHTML = thead + tbody;
      table.querySelectorAll("th").forEach((th) => {{
        th.addEventListener("click", () => {{
          const key = th.dataset.key;
          const metric = th.dataset.metric === "1";
          if (sortState.key === key && Boolean(sortState.metric) === metric) {{
            sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
          }} else {{
            sortState.key = key;
            sortState.metric = metric;
            sortState.direction = metric || ["coverageYears", "sampleCount", "staleDays", "productCount"].includes(key) ? "desc" : "asc";
          }}
          rerender();
        }});
      }});
    }}

    function productCell(product, column, selectedWindow) {{
      if (column.metric) return metricCell(product.metrics[selectedWindow]?.[column.key], column.key);
      if (column.key === "name") return "<td class=\\"name-cell\\"><a class=\\"link\\" href=\\"" + escapeAttr(product.url) + "\\" target=\\"_blank\\" rel=\\"noreferrer\\">" + escapeHtml(product.name) + "</a></td>";
      if (column.key === "operationStatus") return "<td><span class=\\"badge\\">" + escapeHtml(product.operationStatus || "未知") + "</span></td>";
      return "<td>" + escapeHtml(formatPlain(product[column.key])) + "</td>";
    }}

    function benchmarkCell(benchmark, column, selectedWindow) {{
      if (column.metric) return metricCell(benchmark.metrics[selectedWindow]?.[column.key], column.key);
      if (column.key === "groupKey") return "<td class=\\"name-cell\\">" + escapeHtml(benchmark.groupKey) + "</td>";
      return "<td>" + escapeHtml(formatPlain(benchmark[column.key])) + "</td>";
    }}

    function metricCell(value, key) {{
      if (value === undefined || value === null || value === "") return "<td></td>";
      return "<td class=\\"" + metricClass(value, key) + "\\">" + escapeHtml(formatMetric(value, key)) + "</td>";
    }}

    function sortRows(rows, sortState, selectedWindow) {{
      rows.sort((a, b) => {{
        const valueA = sortState.metric ? a.metrics[selectedWindow]?.[sortState.key] : a[sortState.key];
        const valueB = sortState.metric ? b.metrics[selectedWindow]?.[sortState.key] : b[sortState.key];
        const result = compareValues(valueA, valueB);
        return sortState.direction === "asc" ? result : -result;
      }});
    }}

    function compareValues(a, b) {{
      const aMissing = a === undefined || a === null || a === "";
      const bMissing = b === undefined || b === null || b === "";
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      const numberA = Number(a);
      const numberB = Number(b);
      if (Number.isFinite(numberA) && Number.isFinite(numberB)) return numberA - numberB;
      return String(a).localeCompare(String(b), "zh-Hans-CN");
    }}

    function metricClass(value, key) {{
      if (!Number.isFinite(Number(value))) return "";
      if (["annualReturn", "totalReturn", "sharpe", "calmar", "returnDrawdownRatio", "positiveRate"].includes(key)) {{
        return Number(value) >= 0 ? "metric-good" : "metric-bad";
      }}
      if (["maxDrawdown", "currentDrawdown", "annualVolatility", "worstPeriodReturn"].includes(key)) {{
        return Number(value) < 0 ? "metric-bad" : "";
      }}
      return "";
    }}

    function formatMetric(value, key) {{
      if (value === undefined || value === null || value === "") return "";
      const number = Number(value);
      if (!Number.isFinite(number)) return String(value);
      if (percentMetrics.has(key)) return (number * 100).toFixed(2) + "%";
      if (key === "sampleCount") return String(Math.round(number));
      return number.toFixed(2);
    }}

    function formatPlain(value) {{
      if (value === undefined || value === null || value === "") return "";
      if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
      return String(value);
    }}

    function fillWindowSelect(id) {{
      const select = document.getElementById(id);
      select.innerHTML = DATA.windows.map((window) => "<option value=\\"" + window.key + "\\">" + window.label + "</option>").join("");
      select.value = "3y";
      if (!select.value) select.value = DATA.windows[0]?.key || "";
    }}

    function fillSelect(id, values, allLabel) {{
      const select = document.getElementById(id);
      select.innerHTML = "<option value=\\"\\">" + escapeHtml(allLabel) + "</option>" + values.map((value) => "<option value=\\"" + escapeAttr(value) + "\\">" + escapeHtml(value) + "</option>").join("");
    }}

    function uniqueValues(rows, key) {{
      return [...new Set(rows.map((row) => row[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), "zh-Hans-CN"));
    }}

    function bindInputs(ids, handler) {{
      ids.forEach((id) => {{
        const element = document.getElementById(id);
        element.addEventListener("input", handler);
        element.addEventListener("change", handler);
      }});
    }}

    function valueOf(id) {{ return document.getElementById(id).value.trim(); }}
    function numberOf(id) {{
      const value = valueOf(id);
      if (value === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }}
    function clamp(value, min, max) {{ return Math.max(min, Math.min(max, value)); }}
    function escapeHtml(value) {{
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({{ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;" }}[char]));
    }}
    function escapeAttr(value) {{ return escapeHtml(value).replace(/\\n/g, " "); }}
  </script>
</body>
</html>"""


def merge_text_fields(product: dict[str, Any], row: dict[str, str]) -> None:
    mappings = {
        "productName": "name",
        "productUrl": "url",
        "primaryStrategy": "primaryStrategy",
        "secondaryStrategy": "secondaryStrategy",
        "strategyTags": "strategyTags",
        "operationStatus": "operationStatus",
        "recordNumber": "recordNumber",
        "inceptionDate": "inceptionDate",
        "privateManager": "privateManager",
        "companyManagementScale": "companyManagementScale",
        "fundManager": "fundManager",
    }
    for source, target in mappings.items():
        value = clean(row.get(source))
        if value and not product.get(target):
            product[target] = value


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as file:
        return list(csv.DictReader(file))


def read_json_net_value_rows(paths: list[Path]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for path in paths:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        product = payload.get("product") if isinstance(payload.get("product"), dict) else {}
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        product_rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
        product_name = clean(product.get("name")) or path.parent.name
        product_url = clean(product.get("url")) or clean(payload.get("detailUrl"))

        for item in product_rows:
            if not isinstance(item, dict):
                continue
            rows.append(
                {
                    "productName": product_name,
                    "productUrl": product_url,
                    "primaryStrategy": clean(metadata.get("primaryStrategy")),
                    "secondaryStrategy": clean(metadata.get("secondaryStrategy")),
                    "strategyTags": clean(metadata.get("strategyTags")),
                    "operationStatus": clean(metadata.get("operationStatus")),
                    "recordNumber": clean(metadata.get("recordNumber")),
                    "inceptionDate": clean(metadata.get("inceptionDate")),
                    "privateManager": clean(metadata.get("privateManager")),
                    "companyManagementScale": clean(metadata.get("companyManagementScale")),
                    "fundManager": clean(metadata.get("fundManager")),
                    "date": clean(item.get("date")),
                    "unitNetValue": clean(item.get("unitNetValue")),
                    "accumulatedNetValue": clean(item.get("accumulatedNetValue")),
                    "restoredNetValue": clean(item.get("restoredNetValue")),
                    "changeRate": clean(item.get("changeRate")),
                }
            )
    return rows


def write_csv(path: Path, rows: list[list[Any]]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.writer(file)
        writer.writerows(rows)


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def resolve_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT_DIR / path


def first_finite_number(*values: Any) -> float:
    for value in values:
        number = parse_number(value)
        if math.isfinite(number):
            return number
    return math.nan


def parse_number(value: Any) -> float:
    text = clean(value).replace(",", "").replace("%", "")
    if not text or text == "--":
        return math.nan
    try:
        return float(text)
    except ValueError:
        return math.nan


def value_preference(row: dict[str, str]) -> int:
    if math.isfinite(parse_number(row.get("restoredNetValue"))):
        return 3
    if math.isfinite(parse_number(row.get("accumulatedNetValue"))):
        return 2
    if math.isfinite(parse_number(row.get("unitNetValue"))):
        return 1
    return 0


def parse_date(value: Any) -> date:
    return datetime.strptime(clean(value), "%Y-%m-%d").date()


def parse_date_or_none(value: Any) -> date | None:
    try:
        return parse_date(value)
    except ValueError:
        return None


def shift_date(value: date, months: int = 0, years: int = 0) -> date:
    year = value.year - years
    month = value.month - months
    while month <= 0:
        year -= 1
        month += 12
    day = min(value.day, days_in_month(year, month))
    return date(year, month, day)


def days_in_month(year: int, month: int) -> int:
    if month == 12:
        next_month = date(year + 1, 1, 1)
    else:
        next_month = date(year, month + 1, 1)
    return (next_month - date(year, month, 1)).days


def compute_max_drawdown(series: list[Point]) -> float:
    peak = series[0].value
    max_drawdown = 0.0
    for point in series:
        peak = max(peak, point.value)
        drawdown = point.value / peak - 1
        max_drawdown = min(max_drawdown, drawdown)
    return max_drawdown


def compute_current_drawdown(series: list[Point]) -> float:
    peak = max(point.value for point in series)
    latest = series[-1].value
    return latest / peak - 1 if peak > 0 else 0


def safe_ratio(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or denominator is None:
        return None
    if not math.isfinite(numerator) or not math.isfinite(denominator) or abs(denominator) < 1e-12:
        return None
    return numerator / denominator


def round_number(value: float, digits: int) -> float:
    return round(value, digits)


def round_nullable(value: float | None, digits: int) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(value, digits)


def all_dimension_combinations(keys: list[str]) -> list[list[str]]:
    combos = []
    for size in range(1, len(keys) + 1):
        combos.extend([list(combo) for combo in combinations(keys, size)])
    return combos


def label_for_dimension(key: str) -> str:
    for dimension in DIMENSIONS:
        if dimension["key"] == key:
            return dimension["label"]
    return key


def normalize_group_value(value: Any) -> str:
    return clean(value) or "未分类"


def clean(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


if __name__ == "__main__":
    main()

