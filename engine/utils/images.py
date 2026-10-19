"""Image → PDF conversion helpers shared by Merge (A1) and Image to PDF (C1)."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import img2pdf
from PIL import Image, ImageOps, ImageSequence, UnidentifiedImageError

from protocol import EngineError, ErrorCode

try:  # HEIC/HEIF decoding (LGPL libheif/libde265 via pi-heif, decode-only: no GPL x265)
    import pi_heif

    pi_heif.register_heif_opener()
    HEIF_SUPPORTED = True
except ImportError:  # pragma: no cover - optional dependency
    HEIF_SUPPORTED = False

LayoutFun = Callable[..., Any]


def image_to_pdf_bytes(path: Path, work_dir: Path, layout: LayoutFun | None = None) -> bytes:
    """One page per image (every frame of a multi-page TIFF). EXIF orientation is honoured.

    img2pdf embeds JPEG/PNG/TIFF losslessly; inputs it refuses (or HEIC/WEBP with alpha, odd
    modes) are normalised with Pillow first.
    """
    kwargs: dict[str, Any] = {"rotation": img2pdf.Rotation.ifvalid}
    if layout is not None:
        kwargs["layout_fun"] = layout
    if path.suffix.lower() not in (".heic", ".heif"):
        try:
            data: bytes = img2pdf.convert(str(path), **kwargs)
            return data
        except Exception:
            pass
    pngs = normalise_to_png(path, work_dir / path.stem)
    result: bytes = img2pdf.convert(pngs, **kwargs)
    return result


def load_image(path: Path) -> Image.Image:
    """A picture (first frame) upright per its EXIF orientation, kept with its transparency."""
    try:
        with Image.open(path) as img:
            img.load()
            upright = ImageOps.exif_transpose(img) or img
            return upright.copy()
    except Image.DecompressionBombError as exc:
        raise EngineError(
            ErrorCode.INVALID_INPUT, f"{path.name} is too large to process", str(path)
        ) from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise EngineError(
            ErrorCode.CORRUPT_FILE, f"{path.name} is not a readable image", str(path)
        ) from exc


def normalise_to_png(path: Path, work_stem: Path) -> list[str]:
    work_stem.parent.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(path) as img:
            frames = ImageSequence.all_frames(img) if img.format == "TIFF" else [img.copy()]
            pngs: list[str] = []
            for n, frame in enumerate(frames):
                frame = ImageOps.exif_transpose(frame) or frame
                frame = flatten(frame)
                png = work_stem.with_name(f"{work_stem.name}_{n}.png")
                frame.save(png, "PNG")
                pngs.append(str(png))
            return pngs
    except Image.DecompressionBombError as exc:
        raise EngineError(
            ErrorCode.INVALID_INPUT, f"{path.name} is too large to process", str(path)
        ) from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise EngineError(
            ErrorCode.CORRUPT_FILE, f"{path.name} is not a readable image", str(path)
        ) from exc


def flatten(img: Image.Image) -> Image.Image:
    """Composite transparency onto white and convert unusual modes to RGB."""
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    if img.mode not in ("RGB", "L", "CMYK", "1"):
        return img.convert("RGB")
    return img
