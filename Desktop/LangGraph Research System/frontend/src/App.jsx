import React, { useState, useEffect, useRef } from 'react';
import { Phone, PhoneOff, Loader2, CheckCircle, Users, Mic, AlertCircle, Download, FileText, Globe, ExternalLink } from 'lucide-react';
import Vapi from '@vapi-ai/web';
import { jsPDF } from 'jspdf';

const App = () => {
  const [vapi, setVapi] = useState(null);
  const [isCallActive, setIsCallActive] = useState(false);
  const [callStatus, setCallStatus] = useState('Ready to call');
  const [vapiError, setVapiError] = useState(null);
  const [isResearching, setIsResearching] = useState(false);
  const [nodes, setNodes] = useState([]);
  const [results, setResults] = useState(null);
  const [logs, setLogs] = useState([]);
  const [backendStatus, setBackendStatus] = useState('checking');
  const [wsConnected, setWsConnected] = useState(false);
  
  const wsRef = useRef(null);
  const backendUrl = 'http://localhost:8001';
  
  const PUBLIC_KEY = "30dadd95-4974-4d67-b77c-a26c74b99bd5";
  const ASSISTANT_ID = "3b6217ad-f6f9-44bf-b42e-4c6126adbaef";

  useEffect(() => {
    checkBackendHealth();
    const interval = setInterval(checkBackendHealth, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    
    try {
      console.log('🎤 Initializing Vapi...');
      addLog('🎤 Loading voice system...', 'info');
      
      const vapiInstance = new Vapi(PUBLIC_KEY);
      
      vapiInstance.on('call-start', () => {
        if (!mounted) return;
        console.log('✅ Call started successfully');
        setIsCallActive(true);
        setCallStatus('Connected - listening');
        setVapiError(null);
        addLog('🎤 Voice call connected!', 'success');
      });

      // REPLACE the vapi.on('call-end') handler (around line 56) with this:

      vapiInstance.on('call-end', () => {
        if (!mounted) return;
        console.log('📞 Call ended');
        setIsCallActive(false);
        setCallStatus('Ready to call');
        setVapiError(null); // Clear any errors
        addLog('📞 Call ended', 'info');
      });

      vapiInstance.on('speech-start', () => {
        if (!mounted) return;
        setCallStatus('🗣️ Assistant speaking...');
      });

      vapiInstance.on('speech-end', () => {
        if (!mounted) return;
        setCallStatus('👂 Listening to you...');
      });

      // REPLACE line 70-100 in App.jsx (the vapi.on('message') handler)

      vapiInstance.on('message', (message) => {
        if (!mounted) return;
        
        try {
          if (message.type === 'transcript') {
            const prefix = message.role === 'user' ? '👤 You' : '🤖 Assistant';
            addLog(`${prefix}: ${message.transcript}`, 'info');
          }
          
          if (message.type === 'function-call' && message.functionCall?.name === 'start_research') {
            const query = message.functionCall?.parameters?.query;
            if (query) {
              setResults(null);
              setNodes([]);
              setIsResearching(true);
              addLog(`🔬 Research started: "${query}"`, 'success');
            }
          }
        } catch (err) {
          console.error('Message error:', err);
        }
      });

      // REPLACE the vapi.on('error') handler (around line 90) with this:

      vapiInstance.on('error', (error) => {
        if (!mounted) return;
        console.error('❌ Vapi error:', error);
        
        const errorMessage = error?.error?.errorMsg || error?.message || error?.toString() || 'Unknown error';
        
        // Ignore "Meeting has ended" errors - these are normal when call ends
        if (errorMessage.includes('Meeting has ended') || errorMessage.includes('meeting ended')) {
          console.log('ℹ️ Call ended normally');
          setIsCallActive(false);
          setCallStatus('Ready to call');
          return;
        }
        
        // Only show actual errors
        setCallStatus('Error occurred');
        setVapiError(errorMessage);
        addLog(`❌ Voice error: ${errorMessage}`, 'error');
        
        if (errorMessage.includes('403') || errorMessage.toLowerCase().includes('unauthorized')) {
          addLog('⚠️ Authentication failed - check API keys', 'error');
          setVapiError('Authentication failed. Please verify your Vapi credentials.');
        } else if (errorMessage.toLowerCase().includes('network')) {
          addLog('⚠️ Network connection issue', 'error');
          setVapiError('Network error. Check your internet connection.');
        }
      });

      if (mounted) {
        setVapi(vapiInstance);
        setCallStatus('Ready to call');
        addLog('✅ Voice system ready!', 'success');
        console.log('✅ Vapi initialized successfully');
      }

    } catch (error) {
      console.error('❌ Failed to initialize Vapi:', error);
      const errorMsg = error?.message || 'Failed to load voice system';
      setVapiError(errorMsg);
      setCallStatus('Initialization failed');
      addLog(`❌ Voice system failed: ${errorMsg}`, 'error');
    }

    return () => {
      mounted = false;
    };
  }, []);

  const checkBackendHealth = async () => {
    try {
      const response = await fetch(`${backendUrl}/health`);
      if (response.ok) {
        setBackendStatus('online');
      } else {
        setBackendStatus('error');
      }
    } catch (error) {
      setBackendStatus('offline');
    }
  };

  const connectWebSocket = () => {
    try {
      const ws = new WebSocket('ws://localhost:8001/ws');
      
      ws.onopen = () => {
        setWsConnected(true);
        addLog('🔌 Backend connected', 'success');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleWebSocketMessage(data);
        } catch (e) {
          console.error('WebSocket parse error:', e);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setWsConnected(false);
      };

      ws.onclose = () => {
        setWsConnected(false);
        setTimeout(connectWebSocket, 3000);
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('WebSocket connection error:', error);
      setTimeout(connectWebSocket, 3000);
    }
  };

  const handleWebSocketMessage = (data) => {
    switch (data.type) {
      case 'log':
        addLog(data.message, data.log_type || 'info');
        break;
      case 'node_update':
        updateNode(data.node);
        break;
      case 'result':
        // **FIX: Properly handle results**
        setResults(data.data);
        setIsResearching(false);
        addLog('🎉 Research complete! Results ready below.', 'success');
        break;
      case 'clear_results':
        // **FIX: Clear old results**
        setResults(null);
        setNodes([]);
        addLog('🗑️ Cleared previous results', 'info');
        break;
      case 'research_complete':
        addLog('📞 Research finished!', 'success');
        setIsResearching(false);
        break;
      case 'error':
        addLog(`❌ ${data.message}`, 'error');
        setIsResearching(false);
        break;
    }
  };

  const updateNode = (nodeUpdate) => {
    setNodes(prev => {
      const exists = prev.find(n => n.id === nodeUpdate.id);
      if (exists) {
        return prev.map(n => n.id === nodeUpdate.id ? { ...n, ...nodeUpdate } : n);
      }
      return [...prev, nodeUpdate];
    });
  };

  const addLog = (message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-50), { message, type, timestamp }]);
  };

  const startCall = async () => {
    if (!vapi) {
      alert('Voice system is still loading. Please wait a moment and try again.');
      addLog('⚠️ Voice system not ready yet', 'error');
      return;
    }
    
    if (backendStatus !== 'online') {
      alert('Backend server is offline!\n\nPlease start the Python backend:\n\npython backend.py');
      addLog('⚠️ Cannot start - backend offline', 'error');
      return;
    }
    
    if (vapiError) {
      alert(`Cannot start call due to error:\n\n${vapiError}\n\nPlease check:\n1. Your Vapi credentials are correct\n2. Your Vapi account is active\n3. Console for more details`);
      return;
    }
    
    try {
      setCallStatus('Connecting...');
      addLog('📞 Initiating call...', 'info');
      console.log('Starting call with assistant:', ASSISTANT_ID);
      
      await vapi.start(ASSISTANT_ID);
      
      addLog('✅ Call started successfully!', 'success');
    } catch (error) {
      console.error('Failed to start call:', error);
      const errorMsg = error?.message || 'Unknown error';
      setCallStatus('Failed to connect');
      setVapiError(errorMsg);
      addLog(`❌ Call failed: ${errorMsg}`, 'error');
      
      let alertMsg = `Failed to start call:\n\n${errorMsg}\n\n`;
      
      if (errorMsg.includes('403') || errorMsg.toLowerCase().includes('unauthorized')) {
        alertMsg += 'This is usually caused by:\n• Invalid API key\n• Invalid Assistant ID\n• Expired credentials\n\nPlease verify your Vapi credentials at https://vapi.ai';
      } else if (errorMsg.toLowerCase().includes('assistant')) {
        alertMsg += 'Assistant ID may be incorrect. Check your Vapi dashboard.';
      } else {
        alertMsg += 'Check the console for more details.';
      }
      
      alert(alertMsg);
    }
  };

  const endCall = () => {
    if (vapi) {
      try {
        vapi.stop();
        setCallStatus('Ready to call');
        addLog('📞 Call ended by user', 'info');
      } catch (error) {
        console.error('Error ending call:', error);
      }
    }
  };

  const downloadPDF = () => {
    if (!results) {
      addLog('⚠️ No results to export', 'error');
      return;
    }

    try {
      addLog('📄 Generating professional PDF...', 'info');
      
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 20;
      const maxWidth = pageWidth - (margin * 2);
      let y = margin;
      let pageNum = 1;

      const primaryBlue = [41, 128, 185];
      const darkBlue = [52, 73, 94];
      const textGray = [44, 62, 80];
      const lightGray = [149, 165, 166];
      const accentGreen = [46, 204, 113];

      const checkNewPage = (spaceNeeded = 20) => {
        if (y + spaceNeeded > pageHeight - margin - 15) {
          addFooter();
          doc.addPage();
          pageNum++;
          y = margin;
          return true;
        }
        return false;
      };

      const addFooter = () => {
        doc.setFontSize(8);
        doc.setTextColor(...lightGray);
        doc.setFont('helvetica', 'normal');
        
        doc.text(new Date().toLocaleDateString(), margin, pageHeight - 10);
        doc.text(`Page ${pageNum}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
        doc.text('Voice Research System', pageWidth - margin, pageHeight - 10, { align: 'right' });
      };

      const addText = (text, options = {}) => {
        const {
          fontSize = 10,
          fontStyle = 'normal',
          color = textGray,
          indent = 0,
          lineHeight = 1.5,
        } = options;

        if (!text) return;

        doc.setFontSize(fontSize);
        doc.setFont('helvetica', fontStyle);
        doc.setTextColor(...color);

        const lines = doc.splitTextToSize(String(text), maxWidth - indent);
        
        for (let i = 0; i < lines.length; i++) {
          checkNewPage(fontSize * 0.6);
          doc.text(lines[i], margin + indent, y);
          y += fontSize * 0.5 * lineHeight;
        }
      };

      const addSectionHeader = (text, size = 14, color = primaryBlue) => {
        checkNewPage(size + 12);
        y += 8;
        
        doc.setFontSize(size);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...color);
        doc.text(text, margin, y);
        y += size * 0.5;
        
        doc.setDrawColor(...color);
        doc.setLineWidth(0.8);
        doc.line(margin, y + 2, margin + 70, y + 2);
        y += 10;
      };

      // Cover Page
      doc.setFillColor(...primaryBlue);
      doc.rect(0, 0, pageWidth, 55, 'F');
      
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(26);
      doc.setFont('helvetica', 'bold');
      
      const titleLines = doc.splitTextToSize(`Research Report: ${results.query}`, pageWidth - 40);
      
      let titleY = 28;
      titleLines.forEach(line => {
        doc.text(line, pageWidth / 2, titleY, { align: 'center' });
        titleY += 10;
      });

      y = 70;

      // Metadata box
      doc.setDrawColor(200, 200, 200);
      doc.setLineWidth(0.5);
      doc.setFillColor(245, 245, 245);
      doc.roundedRect(margin, y, maxWidth, 40, 3, 3, 'FD');
      
      doc.setTextColor(...textGray);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      
      let metaY = y + 10;
      doc.text(`Generated: ${new Date().toLocaleString()}`, margin + 8, metaY);
      metaY += 8;
      doc.text(`System: Voice Research with Multi-Agent AI`, margin + 8, metaY);
      metaY += 8;
      doc.text(`Sources: ${results.sources?.length || 0} | Confidence: ${results.confidence || 'N/A'}`, margin + 8, metaY);
      
      y += 50;

      // Executive Summary
      addSectionHeader('EXECUTIVE SUMMARY', 16, primaryBlue);
      
      const summaryText = results.summary || 'No summary available';
      const summaryHeight = Math.max(30, doc.splitTextToSize(summaryText, maxWidth - 16).length * 6);
      
      doc.setFillColor(240, 248, 255);
      doc.roundedRect(margin, y, maxWidth, summaryHeight, 2, 2, 'F');
      
      y += 8;
      addText(summaryText, { fontSize: 11, lineHeight: 1.6, indent: 8, color: textGray });
      y += 5;

      // Detailed Analysis
      addSectionHeader('DETAILED ANALYSIS', 16, darkBlue);
      
      const analysis = results.fullSynthesis || results.synthesis || 'No analysis available';
      const paragraphs = analysis.split('\n\n');
      
      paragraphs.forEach((para) => {
        if (!para.trim()) return;
        
        if (para.trim().startsWith('##')) {
          const heading = para.replace(/^#+\s*/, '').trim();
          y += 5;
          addText(heading, { fontSize: 13, fontStyle: 'bold', color: darkBlue, lineHeight: 1.4 });
        } else if (para.trim().startsWith('#')) {
          const heading = para.replace(/^#+\s*/, '').trim();
          y += 3;
          addText(heading, { fontSize: 14, fontStyle: 'bold', color: primaryBlue, lineHeight: 1.4 });
        } else if (para.trim().startsWith('-')) {
          const bullets = para.split('\n').filter(b => b.trim());
          bullets.forEach(bullet => {
            checkNewPage(12);
            const cleanBullet = bullet.replace(/^-\s*/, '');
            doc.setFillColor(...primaryBlue);
            doc.circle(margin + 8, y - 2, 1.5, 'F');
            addText(cleanBullet, { fontSize: 10, indent: 15, lineHeight: 1.5 });
          });
        } else {
          addText(para.trim(), { fontSize: 10, lineHeight: 1.6 });
          y += 4;
        }
      });

      // Sources
      if (results.sources && results.sources.length > 0) {
        doc.addPage();
        pageNum++;
        y = margin;
        
        addSectionHeader('RESEARCH SOURCES', 16, accentGreen);

        results.sources.forEach((source, idx) => {
          checkNewPage(50);

          doc.setFontSize(12);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(...primaryBlue);
          doc.text(`${idx + 1}. ${source.name || source.search_term || 'Source'}`, margin + 5, y);
          y += 8;

          const reliability = parseInt(source.reliability || source.reliability_score || 0);
          const badgeColor = reliability >= 85 ? accentGreen : 
                            reliability >= 70 ? [241, 196, 15] : 
                            [231, 76, 60];
          
          doc.setFillColor(...badgeColor);
          doc.roundedRect(margin + 5, y - 5, 40, 8, 2, 2, 'F');
          
          doc.setTextColor(255, 255, 255);
          doc.setFontSize(9);
          doc.setFont('helvetica', 'bold');
          doc.text(`${reliability}% Reliable`, margin + 25, y, { align: 'center' });
          y += 10;

          if (source.summary) {
            addText(source.summary, {
              fontSize: 9,
              fontStyle: 'italic',
              indent: 5,
              lineHeight: 1.4,
              color: [100, 100, 100]
            });
            y += 5;
          }

          if (source.facts || source.key_facts) {
            const facts = source.facts || source.key_facts;
            
            doc.setFontSize(9);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(...darkBlue);
            doc.text('Key Facts:', margin + 5, y);
            y += 6;

            facts.forEach(fact => {
              checkNewPage(10);
              
              doc.setFillColor(...accentGreen);
              doc.circle(margin + 12, y - 2, 1, 'F');
              
              addText(fact, {
                fontSize: 9,
                indent: 18,
                lineHeight: 1.4,
                color: textGray
              });
            });
          }

          y += 10;
          
          if (idx < results.sources.length - 1) {
            doc.setDrawColor(...lightGray);
            doc.setLineWidth(0.2);
            const lineY = Math.min(y, pageHeight - margin - 20);
            doc.line(margin + 15, lineY, pageWidth - margin - 15, lineY);
            y = lineY + 10;
          }
        });
      }

      addFooter();

      const filename = `Voice_Research_${results.query.slice(0, 30).replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.pdf`;
      doc.save(filename);
      addLog(`✅ Professional PDF downloaded: ${filename}`, 'success');

    } catch (error) {
      console.error('PDF generation error:', error);
      addLog(`❌ PDF generation failed: ${error.message}`, 'error');
    }
  };

  const downloadDOCX = () => {
    if (!results) {
      addLog('⚠️ No results to export', 'error');
      return;
    }

    try {
      let htmlContent = `
        <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'>
        <head>
          <meta charset='utf-8'>
          <title>Research Report</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; margin: 40px; }
            h1 { color: #2980b9; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
            h2 { color: #34495e; margin-top: 30px; border-bottom: 2px solid #95a5a6; padding-bottom: 5px; }
            .metadata { background-color: #ecf0f1; padding: 15px; border-radius: 5px; margin: 20px 0; }
            .source { background-color: #f8f9fa; padding: 15px; margin: 10px 0; border-left: 4px solid #3498db; }
          </style>
        </head>
        <body>
          <h1>Research Report: ${results.query}</h1>
          <div class="metadata">
            <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
            <p><strong>Sources:</strong> ${results.sources?.length || 0}</p>
            <p><strong>Confidence:</strong> ${results.confidence || 'N/A'}</p>
          </div>
          <h2>Executive Summary</h2>
          <p>${results.summary || 'No summary available'}</p>
          <h2>Detailed Analysis</h2>
          <p>${(results.fullSynthesis || results.synthesis || '').replace(/\n/g, '<br>')}</p>
      `;

      if (results.sources && results.sources.length > 0) {
        htmlContent += '<h2>Research Sources</h2>';
        results.sources.forEach((source, idx) => {
          htmlContent += `
            <div class="source">
              <h3>${idx + 1}. ${source.name || source.search_term}</h3>
              <p><strong>Reliability:</strong> ${source.reliability || source.reliability_score}%</p>
              <p>${source.summary}</p>
            </div>
          `;
        });
      }

      htmlContent += '</body></html>';

      const blob = new Blob(['\ufeff', htmlContent], { type: 'application/msword' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Research_${results.query.slice(0, 30).replace(/[^a-z0-9]/gi, '_')}.doc`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      addLog('✅ Word document downloaded', 'success');
    } catch (error) {
      console.error('DOCX generation error:', error);
      addLog(`❌ Word document generation failed: ${error.message}`, 'error');
    }
  };

  const downloadMarkdown = () => {
    if (!results) {
      addLog('⚠️ No results to export', 'error');
      return;
    }

    const md = `# Research Report: ${results.query}

**Generated:** ${new Date().toLocaleString()}
**Confidence:** ${results.confidence}

## Executive Summary

${results.summary}

## Full Analysis

${results.fullSynthesis || results.synthesis}

## Sources

${results.sources?.map((s, i) => `
### ${i + 1}. ${s.name || s.search_term}
- **Reliability:** ${s.reliability || s.reliability_score}%
- **Summary:** ${s.summary}
${s.url ? `- **URL:** ${s.url}` : ''}
`).join('\n') || 'No sources'}
`;

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Research_${results.query.slice(0, 30).replace(/[^a-z0-9]/gi, '_')}.md`;
    a.click();
    URL.revokeObjectURL(url);
    addLog('✅ Markdown downloaded', 'success');
  };

  const getStatusColor = () => {
    switch(backendStatus) {
      case 'online': return 'bg-green-500';
      case 'offline': return 'bg-red-500';
      default: return 'bg-gray-500';
    }
  };

  const getLogIcon = (type) => {
    switch(type) {
      case 'success': return '✅';
      case 'error': return '❌';
      case 'supervisor': return '🧠';
      case 'worker': return '🤖';
      case 'quality': return '🔍';
      default: return 'ℹ️';
    }
  };

  const getNodeStatusColor = (status) => {
    switch(status) {
      case 'active':
      case 'researching':
        return 'bg-blue-500/20 border-blue-400 animate-pulse';
      case 'completed':
        return 'bg-green-500/20 border-green-400';
      default:
        return 'bg-purple-500/20 border-purple-400';
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 p-4">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-4">
            <Phone className="w-12 h-12 text-purple-400" />
            <h1 className="text-5xl font-bold text-white">Voice Research System</h1>
          </div>
          <p className="text-purple-200 text-lg">Speak your research query - Get comprehensive AI-powered results</p>
          <p className="text-purple-300 text-sm mt-1">Vapi Voice + Fireworks AI + LangGraph Multi-Agent System</p>
          
          <div className="flex items-center justify-center gap-6 mt-4 flex-wrap">
            <div className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${getStatusColor()} animate-pulse`}></div>
              <span className="text-sm text-purple-200">Backend: {backendStatus}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${wsConnected ? 'bg-green-500' : 'bg-red-500'} animate-pulse`}></div>
              <span className="text-sm text-purple-200">WebSocket: {wsConnected ? 'Connected' : 'Disconnected'}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${isCallActive ? 'bg-green-500' : vapi ? 'bg-yellow-500' : 'bg-gray-500'} animate-pulse`}></div>
              <span className="text-sm text-purple-200">
                Voice: {isCallActive ? 'Active' : vapi ? 'Ready' : 'Loading...'}
              </span>
            </div>
          </div>
        </div>

        {vapiError && (
          <div className="bg-red-500/20 border-2 border-red-500 rounded-xl p-4 mb-6 backdrop-blur-lg">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-6 h-6 text-red-400 flex-shrink-0 mt-1" />
              <div className="flex-1">
                <h3 className="text-red-400 font-bold mb-1">⚠️ Voice System Error</h3>
                <p className="text-red-200 text-sm mb-2">{vapiError}</p>
                <p className="text-red-300 text-xs">
                  Check browser console for details. Make sure your Vapi credentials are correct.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 mb-6 border border-white/20 shadow-2xl">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <Mic className={`w-8 h-8 ${isCallActive ? 'text-red-400 animate-pulse' : 'text-purple-400'}`} />
              <div>
                <h2 className="text-xl font-bold text-white">Voice Assistant</h2>
                <p className="text-purple-200 text-sm">{callStatus}</p>
              </div>
            </div>
            
            <div className="flex gap-4">
              {!isCallActive ? (
                <button
                  onClick={startCall}
                  disabled={!vapi || backendStatus !== 'online' || !!vapiError}
                  className="px-8 py-4 bg-gradient-to-r from-green-500 to-emerald-500 text-white font-semibold rounded-xl hover:from-green-600 hover:to-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2 shadow-lg"
                >
                  <Phone className="w-5 h-5" />
                  Start Voice Call
                </button>
              ) : (
                <button
                  onClick={endCall}
                  className="px-8 py-4 bg-gradient-to-r from-red-500 to-pink-500 text-white font-semibold rounded-xl hover:from-red-600 hover:to-pink-600 transition-all flex items-center gap-2 shadow-lg"
                >
                  <PhoneOff className="w-5 h-5" />
                  End Call
                </button>
              )}
            </div>
          </div>
          
          {isCallActive && (
            <div className="mt-4 bg-black/20 rounded-xl p-4 border border-green-400/30">
              <p className="text-green-200 text-sm font-medium mb-2">
                💡 <strong>How to use:</strong>
              </p>
              <p className="text-purple-200 text-sm">
                Say: <span className="text-white font-semibold">"I want to research [your topic]"</span>
              </p>
              <p className="text-purple-300 text-xs mt-2">
                Example: "I want to research quantum computing"
              </p>
            </div>
          )}
        </div>

        {isResearching && (
          <div className="bg-blue-500/20 backdrop-blur-lg rounded-2xl p-6 mb-6 border-2 border-blue-400/50 animate-pulse">
            <div className="flex items-center gap-4">
              <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
              <div>
                <h3 className="text-xl font-bold text-white">🔬 Research in Progress</h3>
                <p className="text-blue-200">Multi-agent system is researching... Please wait 30-60 seconds.</p>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20">
            <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-2">
              <Users className="w-6 h-6 text-purple-400" />
              Agent Activity
            </h2>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {nodes.length === 0 ? (
                <div className="text-center py-12 text-purple-200">
                  <p>Agents idle. Start a call to begin research...</p>
                </div>
              ) : (
                nodes.map((node) => (
                  <div
                    key={node.id}
                    className={`p-4 rounded-xl border-2 transition-all ${getNodeStatusColor(node.status)}`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-white font-semibold">{node.label}</span>
                      <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                        node.status === 'completed' ? 'bg-green-500' : 'bg-blue-500'
                      } text-white`}>
                        {node.status || 'idle'}
                      </span>
                    </div>
                    {node.query && (
                      <p className="text-purple-200 text-sm">Task: {node.query}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20">
            <h2 className="text-2xl font-bold text-white mb-4">System Logs</h2>
            <div className="bg-black/30 rounded-xl p-4 h-96 overflow-y-auto space-y-2 font-mono text-sm">
              {logs.length === 0 ? (
                <div className="text-center py-12 text-purple-200">
                  <p>System ready. Start a voice call to begin...</p>
                </div>
              ) : (
                logs.map((log, idx) => (
                  <div key={idx} className={`p-2 rounded transition-colors ${
                    log.type === 'error' ? 'bg-red-500/20 text-red-200' : 
                    log.type === 'success' ? 'bg-green-500/10 text-green-200' : 
                    'text-purple-100 hover:bg-white/5'
                  }`}>
                    <span className="text-purple-400">[{log.timestamp}]</span>{' '}
                    {getLogIcon(log.type)} {log.message}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {results && (
          <div className="mt-6 space-y-6">
            <div className="bg-gradient-to-r from-blue-500/20 to-purple-500/20 backdrop-blur-lg rounded-2xl p-6 border-2 border-blue-400/50">
              <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-2">
                <FileText className="w-7 h-7 text-blue-400" />
                Export Documents
              </h2>
              <div className="grid md:grid-cols-3 gap-4">
                <button
                  onClick={downloadPDF}
                  className="bg-white/10 hover:bg-white/20 border-2 border-red-400 rounded-xl p-4 transition-all flex items-center justify-between group"
                >
                  <div className="text-left">
                    <h3 className="text-red-400 font-bold text-lg">PDF Report</h3>
                    <p className="text-red-200 text-sm">Professional document</p>
                  </div>
                  <Download className="w-6 h-6 text-red-400 group-hover:scale-110 transition-transform" />
                </button>
                
                <button
                  onClick={downloadDOCX}
                  className="bg-white/10 hover:bg-white/20 border-2 border-blue-400 rounded-xl p-4 transition-all flex items-center justify-between group"
                >
                  <div className="text-left">
                    <h3 className="text-blue-400 font-bold text-lg">Word Document</h3>
                    <p className="text-blue-200 text-sm">Editable format</p>
                  </div>
                  <Download className="w-6 h-6 text-blue-400 group-hover:scale-110 transition-transform" />
                </button>
                
                <button
                  onClick={downloadMarkdown}
                  className="bg-white/10 hover:bg-white/20 border-2 border-green-400 rounded-xl p-4 transition-all flex items-center justify-between group"
                >
                  <div className="text-left">
                    <h3 className="text-green-400 font-bold text-lg">Markdown</h3>
                    <p className="text-green-200 text-sm">Web-friendly format</p>
                  </div>
                  <Download className="w-6 h-6 text-green-400 group-hover:scale-110 transition-transform" />
                </button>
              </div>
            </div>

            <div className="bg-gradient-to-r from-green-500/20 to-blue-500/20 backdrop-blur-lg rounded-2xl p-6 border-2 border-green-400/50">
              <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-2">
                <CheckCircle className="w-7 h-7 text-green-400" />
                Research Results
              </h2>
              
              <div className="bg-black/20 rounded-xl p-5 mb-4">
                <h3 className="text-lg font-semibold text-green-400 mb-3">Executive Summary</h3>
                <p className="text-white leading-relaxed mb-3">{results.summary}</p>
                <div className="inline-block px-4 py-2 bg-green-500/30 rounded-lg">
                  <span className="text-green-300 font-semibold">Confidence: {results.confidence}</span>
                </div>
              </div>

              <div className="bg-black/20 rounded-xl p-5 mb-4">
                <h3 className="text-lg font-semibold text-blue-400 mb-3">Full Analysis</h3>
                <div className="text-white leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto">
                  {results.fullSynthesis || results.synthesis}
                </div>
              </div>

              {results.sources && results.sources.length > 0 && (
                <div className="bg-black/20 rounded-xl p-5">
                  <h3 className="text-lg font-semibold text-purple-400 mb-3 flex items-center gap-2">
                    <Globe className="w-5 h-5" />
                    Sources ({results.sources.length})
                  </h3>
                  <div className="space-y-3 max-h-80 overflow-y-auto">
                    {results.sources.map((source, idx) => (
                      <div key={idx} className="bg-white/5 p-3 rounded-lg hover:bg-white/10 transition-all">
                        <div className="flex justify-between items-start mb-2">
                          <div className="flex-1">
                            {source.url ? (
                              <a 
                                href={source.url} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-white font-medium text-sm hover:text-blue-400 flex items-center gap-2 group"
                              >
                                <span className="truncate">{source.name || source.search_term}</span>
                                <ExternalLink className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                              </a>
                            ) : (
                              <span className="text-white font-medium text-sm">{source.name || source.search_term}</span>
                            )}
                            {source.url && (
                              <p className="text-blue-300 text-xs mt-1 truncate">{source.url}</p>
                            )}
                          </div>
                          <span className="text-green-400 text-xs ml-2 flex-shrink-0 bg-green-500/20 px-2 py-1 rounded">
                            {source.reliability || source.reliability_score}%
                          </span>
                        </div>
                        <p className="text-purple-200 text-xs mt-2">{source.summary}</p>
                        {source.key_facts && source.key_facts.length > 0 && (
                          <div className="mt-2 pl-3 border-l-2 border-purple-500/30">
                            <p className="text-purple-300 text-xs font-semibold mb-1">Key Facts:</p>
                            <ul className="text-purple-200 text-xs space-y-1">
                              {source.key_facts.slice(0, 3).map((fact, i) => (
                                <li key={i}>• {fact}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-6 bg-white/5 backdrop-blur-lg rounded-2xl p-6 border border-white/10">
          <h3 className="text-xl font-bold text-white mb-4">📋 Quick Guide</h3>
          <div className="grid md:grid-cols-2 gap-4 text-sm">
            <div className="bg-white/5 p-4 rounded-xl">
              <h4 className="font-semibold text-purple-400 mb-2">🎤 Voice Commands</h4>
              <ul className="text-purple-200 space-y-2">
                <li>• "I want to research artificial intelligence"</li>
                <li>• "Research quantum computing for me"</li>
                <li>• "Tell me about blockchain technology"</li>
              </ul>
            </div>
            <div className="bg-white/5 p-4 rounded-xl">
              <h4 className="font-semibold text-green-400 mb-2">📥 Export Formats</h4>
              <ul className="text-purple-200 space-y-2">
                <li>• PDF - Professional formatted reports</li>
                <li>• DOCX - Editable Word documents</li>
                <li>• Markdown - Developer-friendly format</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;