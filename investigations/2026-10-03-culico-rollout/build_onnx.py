#!/usr/bin/env python3
"""Export culico for the browser: expose the 1152-d penultimate feature, and
append a constant 1.0 coordinate so a linear probe's intercept can be folded
into the weight row (the app's softmaxJoint has no bias term).

The released graph outputs only the 18-way head. Everything else about it is
untouched, so the features are the ones the released checkpoint produces.
"""
import onnx, sys
from onnx import helper, numpy_helper, TensorProto
import numpy as np

SRC = "/workspaces/claude-devcontainer/investigations/2026-10-02-mosquito-id/04-local-models/models/cls/culico-net-cls-v1-17.onnx"
FEAT = "/1/1.2/BatchNormalization_output_0"
DST = "/workspaces/claude-devcontainer/tmp/culico-ship/culico-net-cls-v1-17-embed.onnx"

m = onnx.load(SRC)
for vi in list(m.graph.input) + list(m.graph.output):
    d0 = vi.type.tensor_type.shape.dim[0]
    d0.ClearField("dim_value"); d0.dim_param = "N"

w = None
for n in m.graph.node:
    if n.output and n.output[0] == FEAT:
        init = [t for t in m.graph.initializer if t.name == n.input[1]]
        if init:
            w = int(init[0].dims[-1])
assert w, "penultimate feature not found"
print("penultimate dim", w)

one = numpy_helper.from_array(np.array([[1.0]], np.float32), name="culico_const_one")
m.graph.initializer.append(one)

names = [o.name for o in m.graph.output]
m.graph.node.append(helper.make_node("Concat", [FEAT, "culico_const_one"],
                                     ["culico_embedding"],
                                     axis=1, name="culico_embed_concat"))
m.graph.output.append(helper.make_tensor_value_info(
    "culico_embedding", TensorProto.FLOAT, ["N", w + 1]))
onnx.checker.check_model(m)
onnx.save(m, DST)
print("wrote", DST, "outputs:", names, "+ culico_embedding")
