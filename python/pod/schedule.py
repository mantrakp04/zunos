"""Learning-rate schedule of one training stage (train.py): linear warmup, then cosine decay to 0 at `total` steps."""
import math

import torch


def stage_schedule(opt, peak_lr, warmup, total):
    """A LambdaLR for one stage that peaks at `peak_lr`. LambdaLR scales each group's `initial_lr`, which the first
    scheduler on an optimizer sets once and later ones keep, so it is reset here: without that, stage 2 ran at stage
    1's peak and stage2.lr_mult did nothing."""
    for g in opt.param_groups:
        g["lr"] = g["initial_lr"] = peak_lr
    return torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, (s + 1) / max(1, warmup)) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / max(1, total)))))
