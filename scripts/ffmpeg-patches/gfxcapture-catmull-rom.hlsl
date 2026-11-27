    float4 texBicubic(Texture2D t, SamplerState ss, float2 uv) {
        float2 pos = uv * tS;
        float2 p1 = floor(pos - 0.5) + 0.5;
        float2 f = pos - p1;
        float2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
        float2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
        float2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
        float2 w3 = f * f * (-0.5 + 0.5 * f);
        float2 w12 = w1 + w2;
        float2 p0 = (p1 - 1.0) / tS;
        float2 p3 = (p1 + 2.0) / tS;
        float2 p12 = (p1 + w2 / w12) / tS;
        float4 r = t.Sample(ss, float2(p0.x, p0.y)) * w0.x * w0.y;
        r += t.Sample(ss, float2(p12.x, p0.y)) * w12.x * w0.y;
        r += t.Sample(ss, float2(p3.x, p0.y)) * w3.x * w0.y;
        r += t.Sample(ss, float2(p0.x, p12.y)) * w0.x * w12.y;
        r += t.Sample(ss, float2(p12.x, p12.y)) * w12.x * w12.y;
        r += t.Sample(ss, float2(p3.x, p12.y)) * w3.x * w12.y;
        r += t.Sample(ss, float2(p0.x, p3.y)) * w0.x * w3.y;
        r += t.Sample(ss, float2(p12.x, p3.y)) * w12.x * w3.y;
        r += t.Sample(ss, float2(p3.x, p3.y)) * w3.x * w3.y;
        return r;
    }

