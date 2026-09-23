"""
test_figure.py — the shared image pane.

`robust_levels` gets the most attention because it is the one piece of real
arithmetic here, and every one of its cases is a way a live viewer goes solid
black or solid white on real hardware.
"""
from __future__ import annotations

import numpy as np
import pytest

from de_shell.plotting.figure import FigureView, fill_iframe_html, robust_levels


class TestRobustLevels:
    def test_a_hot_pixel_does_not_set_the_ceiling(self):
        # THE case this exists for: one saturated pixel under a min/max range
        # compresses everything else into the bottom of the scale and the image
        # renders black. Every real detector has hot pixels.
        rng = np.random.default_rng(0)
        frame = rng.normal(100.0, 5.0, (64, 64))
        frame[0, 0] = 65535.0
        lo, hi = robust_levels(frame)
        assert hi < 1000.0, "a single hot pixel dominated the display range"

    def test_a_sparse_image_scales_to_its_spots(self):
        # A count map that is >99.5% zeros: the percentile IS zero, so the
        # function falls back to the true maximum. Without that the few bright
        # spots all saturate against a 1-wide window. This is why the fallback
        # chain is max-then-widen and not widen-only.
        frame = np.zeros((256, 256))
        frame[3, 4] = 5000.0
        assert robust_levels(frame, low=None, high=99.5) == (0.0, 5000.0)

    def test_uniform_frame_still_gets_a_usable_range(self):
        # A zero-width window renders as a solid block, indistinguishable from a
        # broken decode.
        lo, hi = robust_levels(np.full((8, 8), 7.0))
        assert hi > lo

    def test_all_nan_frame_does_not_raise_or_return_nan(self):
        lo, hi = robust_levels(np.full((8, 8), np.nan))
        assert np.isfinite(lo) and np.isfinite(hi) and hi > lo

    def test_partially_nan_frame_uses_the_finite_values(self):
        frame = np.full((8, 8), np.nan)
        frame[0, :4] = [1.0, 2.0, 3.0, 4.0]
        lo, hi = robust_levels(frame)
        assert np.isfinite(lo) and np.isfinite(hi) and hi > lo

    def test_spans_the_bulk_of_an_ordinary_frame(self):
        frame = np.linspace(0.0, 1000.0, 10_000).reshape(100, 100)
        lo, hi = robust_levels(frame)
        assert 0.0 <= lo < 50.0 and 950.0 < hi <= 1000.0

    def test_low_none_uses_the_true_minimum(self):
        # The navigator band. Clipping the floor of an image with no saturating
        # spike throws away real dynamic range.
        frame = np.linspace(5.0, 1000.0, 10_000).reshape(100, 100)
        assert robust_levels(frame, low=None, high=99.5)[0] == 5.0
        assert robust_levels(frame, low=2.0, high=99.5)[0] > 5.0

    def test_percentiles_are_configurable(self):
        frame = np.linspace(0.0, 100.0, 10_000).reshape(100, 100)
        tight = robust_levels(frame, low=25.0, high=75.0)
        wide = robust_levels(frame, low=0.0, high=100.0)
        assert tight[0] > wide[0] and tight[1] < wide[1]

    def test_a_large_frame_is_subsampled_rather_than_measured_whole(self):
        # Percentiles over 16 M pixels land on the paint path. Sampling must not
        # change the answer materially — compare a small sample against a big one
        # drawn from the same distribution.
        rng = np.random.default_rng(1)
        big = rng.normal(500.0, 50.0, (2048, 2048))
        coarse = robust_levels(big, sample=64)
        fine = robust_levels(big, sample=2048)
        assert np.allclose(coarse, fine, rtol=0.05)

    def test_a_1d_line_is_handled(self):
        lo, hi = robust_levels(np.linspace(0.0, 10.0, 4096))
        assert np.isfinite(lo) and np.isfinite(hi) and hi > lo

    def test_integer_frames_are_handled(self):
        lo, hi = robust_levels(np.arange(256, dtype=np.uint16).reshape(16, 16))
        assert np.isfinite(lo) and np.isfinite(hi) and hi > lo

    def test_an_empty_frame_returns_a_safe_default(self):
        assert robust_levels(np.zeros((0, 0))) == (0.0, 1.0)


class TestFigureViewLifecycle:
    """No anyplotlib figure is built here — these cover the guards around it,
    which are what keep teardown and pre-open calls from raising."""

    def test_starts_closed_with_no_fig_id(self):
        v = FigureView(0, title="t")
        assert v.fig_id is None and not v.is_open

    def test_painting_before_open_is_a_no_op_not_a_crash(self):
        # A frame can arrive from an acquisition thread before open() has run.
        assert FigureView(0).show(np.zeros((4, 4))) is False

    def test_colormap_and_title_before_open_are_retained(self):
        v = FigureView(0)
        v.set_colormap("viridis")
        v.set_title("later")
        assert v._colormap == "viridis" and v.title == "later"

    def test_close_is_idempotent(self):
        v = FigureView(0)
        v.close()
        v.close()
        assert not v.is_open

    def test_painting_after_close_is_a_no_op(self):
        # The teardown ordering that matters: acquisition is stopped first, but
        # a frame already in flight must not resurrect a closed window.
        v = FigureView(0)
        v.close()
        assert v.show(np.zeros((4, 4))) is False


class TestTileQuantisationBand:
    """A frame larger than anyplotlib's tile threshold is auto-swapped to tile
    mode, where pixels are quantised to uint8 over the raw_min/raw_max band.
    A figure opened on its zeros placeholder derives that band from the zeros
    — (0, 0) — and `_set_data_tiled` never re-derives it. The two ends of the
    protocol then disagree on the degenerate band: the Python encoder falls
    back to the display window, but the frontend LUT honours (0, 0) — every
    byte maps below the display floor and the pane renders black however good
    the data. Found live: every Calibrate/FFT/Motion still on an 8k detector.
    """

    def _open_and_show(self, shape):
        rng = np.random.default_rng(0)
        v = FigureView(0, title="t")
        v.open(shape)
        frame = rng.normal(140.0, 30.0, shape).astype(np.float32)
        assert v.show(frame) is True
        return v, frame

    def test_large_frame_after_placeholder_open_gets_a_valid_band(self):
        v, frame = self._open_and_show((2048, 2048))
        st = v._plot2d._state
        # Precondition: the swap actually happened — otherwise this test is
        # asserting nothing about the tile path.
        assert st.get("tile_enabled") is True
        lo, hi = st.get("raw_min"), st.get("raw_max")
        assert lo is not None and hi is not None and hi > lo, (
            f"degenerate quantisation band ({lo}, {hi}) — frontend LUT "
            f"renders every pixel black")
        # The band must cover the frame, or values clamp at the band edges.
        assert lo <= float(frame.min()) and hi >= float(frame.max())

    def test_small_frame_stays_untiled_and_unaffected(self):
        v, _ = self._open_and_show((64, 64))
        assert not v._plot2d._state.get("tile_enabled")


class TestOverlays:
    """Widgets and labels on a real, open figure."""

    @staticmethod
    def _open():
        v = FigureView(0, title="t")
        v.open((64, 64))
        return v

    def test_a_rectangle_carries_its_geometry_style_and_cap(self):
        w = self._open().add_rectangle_widget(
            x=1, y=2, w=3, h=4, color="#123456", max_extent=10,
            show_handles=False, linewidth=1)
        assert (w.x, w.y, w.w, w.h) == (1.0, 2.0, 3.0, 4.0)
        assert w.color == "#123456" and w.linewidth == 1.0
        assert w.show_handles is False and (w.max_w, w.max_h) == (10.0, 10.0)

    def test_a_rectangle_reports_where_a_drag_settles(self):
        heard = []
        w = self._open().add_rectangle_widget(
            x=1, y=2, w=3, h=4, on_change=lambda *g: heard.append(g))
        w._update_from_js({"x": 5.0, "y": 6.0}, "pointer_move")
        assert heard == []                    # once per drag, not per frame
        w._update_from_js({"w": 7.0, "h": 8.0}, "pointer_up")
        assert heard == [(5.0, 6.0, 7.0, 8.0)]

    def test_a_rectangle_moved_from_python_lands_without_a_callback(self):
        heard = []
        w = self._open().add_rectangle_widget(
            x=1, y=2, w=3, h=4, on_change=lambda *g: heard.append(g))
        assert FigureView.set_widget_geometry(w, x=9, y=9, w=5, h=5)
        assert (w.x, w.y, w.w, w.h) == (9.0, 9.0, 5.0, 5.0) and heard == []

    def test_a_rectangle_on_a_closed_figure_is_none(self):
        assert FigureView(0).add_rectangle_widget(x=0, y=0, w=1, h=1) is None

    def test_a_refused_rectangle_is_none_and_a_warning(self, monkeypatch, caplog):
        v = self._open()

        def boom(**_kw):
            raise RuntimeError("boom")

        monkeypatch.setattr(v._plot2d, "add_rectangle_widget", boom)
        assert v.add_rectangle_widget(x=0, y=0, w=1, h=1) is None
        assert "rectangle" in caplog.text

    def test_texts_are_drawn_and_a_name_replaces_them_in_place(self):
        v = self._open()
        v.add_texts([[4, 5]], ["edge (auto)"], name="labels",
                    outline_color="#000000")
        g = v.add_texts([[6, 7]], ["noise"], name="labels")
        texts = v._plot2d.markers["texts"]
        assert len(texts) == 1 and g._data["texts"] == ["noise"]
        v.remove_widget(g)
        assert "labels" not in texts

    def test_texts_accept_one_colour_per_text(self):
        v = self._open()
        g = v.add_texts([[4, 5], [6, 7]], ["a", "b"],
                         color=["#ff0000", "#00ff00"])
        assert g._data["color"] == ["#ff0000", "#00ff00"]

    def test_texts_on_a_closed_figure_are_none(self):
        assert FigureView(0).add_texts([[0, 0]], ["x"]) is None


class TestReadout:
    def test_the_pill_can_be_hidden_for_the_host_to_draw_its_own(self):
        v = FigureView(0)
        v.open((64, 64))
        assert v.set_readout_visible(False) is True
        assert v._plot2d._state["readout_visible"] is False

    def test_hiding_the_pill_on_a_closed_figure_is_a_no_op(self):
        assert FigureView(0).set_readout_visible(False) is False

    def test_every_figure_frame_relays_its_readout_to_the_host(self):
        head = fill_iframe_html("<head></head><body></body>").split("<body>")[0]
        assert "apl:readout" in head and "apl_readout" in head
