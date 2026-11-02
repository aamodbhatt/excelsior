"""Trains the tiny GPT on a list of names and exports float64 weights plus parity fixtures.

Usage: uv run python -m excelsior_ml.train_transformer --steps 3000 --device cpu --out runs/transformer
Smoke: uv run python -m excelsior_ml.train_transformer --steps 200 --device cpu --out runs/smoke
"""

from __future__ import annotations

import argparse
import json
import random
import time
import urllib.request
from pathlib import Path

import torch
from torch import Tensor
from torch.nn import functional

from .transformer import VOCAB, GptConfig, TinyGpt, encode, param_count

NAMES_URL = "https://raw.githubusercontent.com/karpathy/makemore/master/names.txt"
PARITY_PROMPTS = ["", "a", "em", "chris", "isabella", "zz", "jonathanmarquez"]


def load_names(path: Path) -> list[str]:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(NAMES_URL, path)
    names = [w.strip().lower() for w in path.read_text().splitlines() if w.strip()]
    return [n for n in names if all(ch in VOCAB[1:] for ch in n)]


def make_examples(names: list[str], block: int) -> tuple[Tensor, Tensor]:
    """Each name becomes '.name.'; inputs are left-aligned windows padded with '.'."""
    xs: list[list[int]] = []
    ys: list[list[int]] = []
    for name in names:
        ids = encode("." + name + ".")[: block + 1]
        x = ids[:-1] + [0] * (block - len(ids) + 1)
        y = ids[1:] + [-1] * (block - len(ids) + 1)
        xs.append(x)
        ys.append(y)
    return torch.tensor(xs), torch.tensor(ys)


def evaluate(model: TinyGpt, x: Tensor, y: Tensor) -> float:
    model.eval()
    with torch.no_grad():
        logits, _ = model(x)
        loss = functional.cross_entropy(logits.reshape(-1, logits.shape[-1]), y.reshape(-1), ignore_index=-1)
    model.train()
    return float(loss)


def export(model: TinyGpt, cfg: GptConfig, out: Path, metrics: dict[str, float]) -> None:
    """Writes weights (as exact float64 values of the trained float32 tensors) and float64 parity outputs."""
    model = model.to("cpu").double().eval()
    tensors = {
        name: {"shape": list(t.shape), "data": t.detach().reshape(-1).tolist()}
        for name, t in model.state_dict().items()
    }
    weights = {
        "config": {**cfg.__dict__, "head_dim": cfg.head_dim},
        "vocab": VOCAB,
        "params": param_count(model),
        "metrics": metrics,
        "tensors": tensors,
    }
    (out / "names-gpt.json").write_text(json.dumps(weights))
    cases = []
    with torch.no_grad():
        for prompt in PARITY_PROMPTS:
            context = ("." + prompt)[-cfg.block_size :]
            idx = torch.tensor([encode(context)])
            logits, atts = model(idx)
            probs = torch.softmax(logits[0, -1], dim=-1)
            cases.append(
                {
                    "prompt": prompt,
                    "context": context,
                    "logits": logits[0].tolist(),
                    "attention": [a[0].tolist() for a in atts],
                    "probs": probs.tolist(),
                }
            )
    (out / "names-gpt-parity.json").write_text(json.dumps({"dtype": "float64", "cases": cases}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--steps", type=int, default=4000)
    parser.add_argument("--batch", type=int, default=512)
    parser.add_argument("--lr", type=float, default=3e-3)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--data", type=Path, default=Path("data/names.txt"))
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=1337)
    args = parser.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    cfg = GptConfig()
    names = load_names(args.data)
    random.shuffle(names)
    split = int(0.9 * len(names))
    xtr, ytr = make_examples(names[:split], cfg.block_size)
    xva, yva = make_examples(names[split:], cfg.block_size)
    xtr, ytr, xva, yva = (t.to(args.device) for t in (xtr, ytr, xva, yva))

    model = TinyGpt(cfg).to(args.device)
    print(f"params: {param_count(model)}  train names: {split}  device: {args.device}")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.steps)
    start = time.time()
    for step in range(args.steps + 1):
        ix = torch.randint(0, xtr.shape[0], (args.batch,), device=args.device)
        logits, _ = model(xtr[ix])
        loss = functional.cross_entropy(
            logits.reshape(-1, cfg.vocab_size), ytr[ix].reshape(-1), ignore_index=-1
        )
        opt.zero_grad(set_to_none=True)
        loss.backward()  # type: ignore[no-untyped-call]  # torch leaves backward() unannotated
        opt.step()
        sched.step()
        if step % 500 == 0:
            print(f"step {step:5d}  train {loss.item():.4f}  val {evaluate(model, xva, yva):.4f}")
    metrics = {
        "train_loss": evaluate(model, xtr, ytr),
        "val_loss": evaluate(model, xva, yva),
        "seconds": time.time() - start,
        "steps": float(args.steps),
    }
    print(json.dumps(metrics))
    args.out.mkdir(parents=True, exist_ok=True)
    export(model, cfg, args.out, metrics)


if __name__ == "__main__":
    main()
