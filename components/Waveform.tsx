
import React, { useRef, useEffect } from 'react';

interface WaveformProps {
  analyserNode: AnalyserNode | null;
  isActive: boolean;
}

export const Waveform: React.FC<WaveformProps> = ({ analyserNode, isActive }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!analyserNode || !canvasRef.current || !isActive) return;

    const canvas = canvasRef.current;
    const canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) return;

    analyserNode.fftSize = 256;
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    let animationFrameId: number;

    const draw = () => {
      animationFrameId = requestAnimationFrame(draw);

      analyserNode.getByteTimeDomainData(dataArray);

      canvasCtx.fillStyle = 'rgb(17 24 39)'; // bg-gray-900
      canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
      canvasCtx.lineWidth = 3;
      canvasCtx.strokeStyle = 'rgb(37 99 235)'; // text-blue-600

      canvasCtx.beginPath();

      const sliceWidth = canvas.width * 1.0 / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * canvas.height / 2;

        if (i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      canvasCtx.lineTo(canvas.width, canvas.height / 2);
      canvasCtx.stroke();
    };

    draw();

    return () => {
      cancelAnimationFrame(animationFrameId);
      if (canvasCtx) {
         canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
  }, [analyserNode, isActive]);

  return (
    <div className={`w-full h-24 transition-opacity duration-500 ${isActive ? 'opacity-100' : 'opacity-0'}`}>
        <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  );
};
