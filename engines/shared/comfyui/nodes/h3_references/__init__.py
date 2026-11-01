"""CPU frame-rate conversion for native H3 reference-video workflows."""
import math
import comfy.utils

class MiniMaxH3ReferenceVideoFrames:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'images': ('IMAGE',), 'fps': ('FLOAT', {'default': 24.0, 'min': 0.01, 'max': 1000.0}),
                             'max_edge': ('INT', {'default': 1344, 'min': 320, 'max': 2048, 'step': 32})}}
    RETURN_TYPES = ('IMAGE',)
    FUNCTION = 'convert'
    CATEGORY = 'model/conditioning/minimax'
    DESCRIPTION = '参考视频按真实帧率转换为24fps；2–15秒。保持宽高比，只缩小，不放大。音轨请从GetVideoComponents直接连接到同编号参考音轨。'

    def convert(self, images, fps, max_edge):
        if not math.isfinite(fps) or fps <= 0:
            raise ValueError('Reference video requires a valid frame rate')
        duration = len(images) / fps
        if not 2 <= duration <= 15.05:
            raise ValueError('H3 reference videos must contain 2–15 seconds; trim the video before loading')
        height, width = images.shape[1:3]
        scale = min(1.0, max_edge / max(width, height))
        if scale < 1:
            images = comfy.utils.common_upscale(images.movedim(-1, 1), max(1, round(width * scale)),
                                                max(1, round(height * scale)), 'area', 'disabled').movedim(1, -1)
        # 24fps conditioning is required even when the source is 25/30/60fps.
        indices = [min(len(images)-1, int(i * fps / 24)) for i in range(min(360, round(duration * 24)))]
        return (images[indices],)

NODE_CLASS_MAPPINGS = {'MiniMaxH3ReferenceVideoFrames': MiniMaxH3ReferenceVideoFrames}
NODE_DISPLAY_NAME_MAPPINGS = {'MiniMaxH3ReferenceVideoFrames': 'H3 · 参考视频转24fps'}
