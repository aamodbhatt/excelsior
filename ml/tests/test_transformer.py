"""Checks the properties the spreadsheet compiler relies on, using a tiny random model on CPU."""

from __future__ import annotations

import json
from pathlib import Path

import torch

from excelsior_ml.train_transformer import export, make_examples
from excelsior_ml.transformer import VOCAB, GptConfig, TinyGpt, encode, param_count


def test_default_model_is_small_enough_for_a_sheet() -> None:
    assert param_count(TinyGpt(GptConfig())) <= 50_000


def test_causal_softmax_equals_exp_mask_rowsum() -> None:
    """The sheet computes exp(s) * mask / rowsum(exp(s) * mask); PyTorch masks with -inf first."""
    torch.manual_seed(0)
    s = torch.randn(6, 6, dtype=torch.float64) * 3
    mask = torch.tril(torch.ones(6, 6, dtype=torch.float64))
    reference = torch.softmax(s.masked_fill(mask == 0, float("-inf")), dim=-1)
    e = torch.exp(s) * mask
    sheet = e / e.sum(dim=-1, keepdim=True)
    torch.testing.assert_close(sheet, reference, rtol=0, atol=1e-15)


def test_encode_maps_unknown_characters_to_boundary() -> None:
    assert encode(".Ab?") == [0, 1, 2, 0]
    assert VOCAB[0] == "."


def test_examples_are_left_aligned_and_padded() -> None:
    x, y = make_examples(["ab"], block=5)
    assert x.tolist() == [[0, 1, 2, 0, 0]]
    assert y.tolist() == [[1, 2, 0, -1, -1]]


def test_export_round_trips_float64_outputs(tmp_path: Path) -> None:
    torch.manual_seed(0)
    cfg = GptConfig()
    model = TinyGpt(cfg)
    export(model, cfg, tmp_path, {"val_loss": 0.0})
    weights = json.loads((tmp_path / "names-gpt.json").read_text())
    parity = json.loads((tmp_path / "names-gpt-parity.json").read_text())
    assert weights["params"] == param_count(model)
    rebuilt = TinyGpt(cfg).double()
    rebuilt.load_state_dict(
        {
            k: torch.tensor(v["data"], dtype=torch.float64).reshape(v["shape"])
            for k, v in weights["tensors"].items()
        },
        strict=False,
    )
    case = parity["cases"][2]
    logits, atts = rebuilt(torch.tensor([encode(case["context"])]))
    torch.testing.assert_close(
        logits[0], torch.tensor(case["logits"], dtype=torch.float64), rtol=0, atol=1e-12
    )
    torch.testing.assert_close(
        atts[0][0], torch.tensor(case["attention"][0], dtype=torch.float64), rtol=0, atol=1e-12
    )
