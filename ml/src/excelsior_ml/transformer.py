"""A tiny char-level GPT whose every operation has a direct spreadsheet-formula counterpart.

Design constraints come from the sheet: attention is written out explicitly (so attention weights can be
shown as heat-maps), GELU uses the tanh approximation (TANH exists in Excel), and the causal softmax is
computed as exp(s) * mask / rowsum, which is algebraically identical to masking with -inf.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import torch
from torch import Tensor, nn

VOCAB = ".abcdefghijklmnopqrstuvwxyz"


@dataclass(frozen=True)
class GptConfig:
    vocab_size: int = len(VOCAB)
    block_size: int = 16
    d_model: int = 32
    n_heads: int = 2
    n_layers: int = 2
    mlp_ratio: int = 4

    @property
    def head_dim(self) -> int:
        return self.d_model // self.n_heads


class Attention(nn.Module):
    def __init__(self, cfg: GptConfig) -> None:
        super().__init__()
        self.cfg = cfg
        self.q = nn.Linear(cfg.d_model, cfg.d_model)
        self.k = nn.Linear(cfg.d_model, cfg.d_model)
        self.v = nn.Linear(cfg.d_model, cfg.d_model)
        self.proj = nn.Linear(cfg.d_model, cfg.d_model)
        self.register_buffer("mask", torch.tril(torch.ones(cfg.block_size, cfg.block_size)), persistent=False)

    def forward(self, x: Tensor) -> tuple[Tensor, Tensor]:
        b, t, d = x.shape
        h, hd = self.cfg.n_heads, self.cfg.head_dim
        q = self.q(x).view(b, t, h, hd).transpose(1, 2)
        k = self.k(x).view(b, t, h, hd).transpose(1, 2)
        v = self.v(x).view(b, t, h, hd).transpose(1, 2)
        scores = q @ k.transpose(-2, -1) / math.sqrt(hd)
        mask: Tensor = self.mask[:t, :t]  # type: ignore[index]
        scores = scores.masked_fill(mask == 0, float("-inf"))
        att = torch.softmax(scores, dim=-1)
        out = (att @ v).transpose(1, 2).contiguous().view(b, t, d)
        return self.proj(out), att


class Block(nn.Module):
    def __init__(self, cfg: GptConfig) -> None:
        super().__init__()
        self.ln1 = nn.LayerNorm(cfg.d_model)
        self.attn = Attention(cfg)
        self.ln2 = nn.LayerNorm(cfg.d_model)
        self.fc = nn.Linear(cfg.d_model, cfg.mlp_ratio * cfg.d_model)
        self.out = nn.Linear(cfg.mlp_ratio * cfg.d_model, cfg.d_model)
        self.act = nn.GELU(approximate="tanh")

    def forward(self, x: Tensor) -> tuple[Tensor, Tensor]:
        a, att = self.attn(self.ln1(x))
        x = x + a
        x = x + self.out(self.act(self.fc(self.ln2(x))))
        return x, att


class TinyGpt(nn.Module):
    def __init__(self, cfg: GptConfig) -> None:
        super().__init__()
        self.cfg = cfg
        self.wte = nn.Embedding(cfg.vocab_size, cfg.d_model)
        self.wpe = nn.Embedding(cfg.block_size, cfg.d_model)
        self.blocks = nn.ModuleList([Block(cfg) for _ in range(cfg.n_layers)])
        self.ln_f = nn.LayerNorm(cfg.d_model)
        self.head = nn.Linear(cfg.d_model, cfg.vocab_size)

    def forward(self, idx: Tensor) -> tuple[Tensor, list[Tensor]]:
        """Returns logits (B x T x V) and per-layer attention (B x H x T x T)."""
        t = idx.shape[1]
        pos = torch.arange(t, device=idx.device)
        x = self.wte(idx) + self.wpe(pos)
        atts: list[Tensor] = []
        for block in self.blocks:
            x, att = block(x)
            atts.append(att)
        return self.head(self.ln_f(x)), atts


def encode(text: str) -> list[int]:
    """Maps characters to ids; anything outside a-z becomes the '.' boundary token."""
    return [VOCAB.index(ch) if ch in VOCAB else 0 for ch in text.lower()]


def param_count(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())
