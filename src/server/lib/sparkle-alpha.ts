// Auto-derived Gemini sparkle watermark alpha maps
// Derived from solid-color test images with known backgrounds
// The watermark is a white sparkle composited with alpha blending

// Alpha map for 512x512 images
// Sparkle at (472, 472), size 24x24, margin: right 16, bottom 16
const ALPHA_512_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABDklEQVR4nK2UQY6EIBAAeYjBeGD+wwnOIL4AQvokNGnfvRnNTlzHWUe0biZaCU3ZjB2hlNJas+t472OMN4hopm3bSxZrbZ6x1tZbhBBENM4QUdM0lSIASCktopSS977GMgwDIo4rENEYc84ipSyljG+UUqSU31qMMbuWhVKKc+5AwTkPIWxONM4DWj8iIgAIIfYVxhgi2nzziZQSEf1pQmsdYySinPN4kpwzEXnvlVJPUQjhiijG+BS9sNZWHI1zvjOpx+MBAO/D3oCI3vvj0J1z/1+/+T7Le4L8lCUiHqe4Swhh/dMCQI1lqZR+18g0Tfspn11sfd/XWxhjXdctq/aSZSHGGEK4QaRnDt/7ARPsNY7k7jNkAAAAAElFTkSuQmCC';

// Alpha map for 1024x1024 images  
// Sparkle at (472, 472), size 24x24, margin: right 16, bottom 16
const ALPHA_1024_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABCElEQVR4nK2VQW7EIAxFcwa2iAU3YsMeZK5g2btghO9dNVSdaBolGdJ3gCcw/5tluSJuLM9BRCJ6ajHG6IZz7pEIAGQj5zxv8d6r6rqhqtbaSREz11qHqNaKiDOWUoqIrDtaaymlzywhhN77+ofeewjhriWldGgZ9N5LKRcKay0ittbWU0SEmb33BwrnXM5ZVX+ne06tVVUBwBjzo4gxEpGqvo32DiKiqoj43aEYIyI+ERHRq4zGGAD49Go55+PqeO+Z+fJorTVEvA56KeX8+dP9WP5PIAcppbdAich1FA9BxH1pmXnGMoKuuzVyHOWb5JzHYgOAecuozli1rypMQ0STK+2Nm9/RFxJ1NXxaE81wAAAAAElFTkSuQmCC';

export interface WatermarkConfig {
  width: number;
  height: number;
  x: number;
  y: number;
  base64: string;
}

export const WATERMARK_CONFIGS: Record<string, WatermarkConfig> = {
  '512x512': {
    width: 24,
    height: 24,
    x: 472,
    y: 472,
    base64: ALPHA_512_BASE64,
  },
  '1024x1024': {
    width: 24,
    height: 24,
    x: 472,
    y: 472,
    base64: ALPHA_1024_BASE64,
  },
};
