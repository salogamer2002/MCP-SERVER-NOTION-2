import React, { useState, useRef, useEffect } from 'react';
import { Mic, MicOff } from 'lucide-react';

function App() {
  // Existing chat states
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [notionKey, setNotionKey] = useState('');
  const [fireworksKey, setFireworksKey] = useState('');
  const [showSetup, setShowSetup] = useState(true);
  const messagesEndRef = useRef(null);

  // NEW: Voice states
  const [vapi, setVapi] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [callStatus, setCallStatus] = useState('');

  const API_URL = 'http://localhost:8000';

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // NEW: Initialize Web Speech API for transcription only
  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognition = new SpeechRecognition();
      
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';
      
      recognition.onstart = () => {
        setIsRecording(true);
        setCallStatus('🎙️ Listening...');
      };
      
      recognition.onresult = (event) => {
        let interimTranscript = '';
        let finalTranscript = '';
        
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += transcript + ' ';
          } else {
            interimTranscript += transcript;
          }
        }
        
        // Update input with final transcript
        if (finalTranscript) {
          setInput(prev => prev + finalTranscript);
        }
        
        // Show interim in status
        if (interimTranscript) {
          setCallStatus('🎙️ ' + interimTranscript);
        }
      };
      
      recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        setCallStatus('❌ Error: ' + event.error);
        setIsRecording(false);
      };
      
      recognition.onend = () => {
        setIsRecording(false);
        setCallStatus('');
      };
      
      setVapi(recognition);
    }
    
    return () => {
      // Cleanup handled by stopRecording
    };
  }, []);

  const connectToNotion = async () => {
    if (!notionKey.trim()) {
      alert('Please enter your Notion API key');
      return;
    }
    if (!fireworksKey.trim()) {
      alert('Please enter your Fireworks API key');
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notion_key: notionKey,
          fireworks_key: fireworksKey
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.status === 'connected') {
        setConnected(true);
        setShowSetup(false);

        setMessages([{
          type: 'system',
          content: `✅ Connected to Notion MCP Server successfully!
🎯 Model: Kimi K2 (256K context window)
🧠 Enhanced reasoning and long-context analysis enabled

📋 Available tools:
${data.tools.map(t => `• ${t}`).join('\n')}

💡 You can now use text chat OR voice input to interact with your Notion workspace!`,
          timestamp: new Date()
        }]);
      } else {
        throw new Error(data.message || 'Connection failed');
      }
    } catch (error) {
      alert('Connection failed: ' + error.message);
      setMessages([{
        type: 'system',
        content: '❌ Connection failed. Please check your API keys and backend.',
        timestamp: new Date()
      }]);
    } finally {
      setLoading(false);
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || loading) return;

    const userMessage = {
      type: 'user',
      content: input,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    const currentInput = input;
    setInput('');
    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: currentInput,
          notion_key: notionKey,
          fireworks_key: fireworksKey
        })
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      const data = await response.json();

      const agentResponse = {
        type: 'agent',
        content: data.response,
        timestamp: new Date(),
        tools_used: data.tools_used || [],
        model: data.model
      };

      setMessages(prev => [...prev, agentResponse]);
    } catch (error) {
      const errorMessage = {
        type: 'system',
        content: '❌ Error: ' + error.message,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  };

  // NEW: Voice recording functions
  const startRecording = () => {
    if (vapi) {
      setInput(''); // Clear input before new recording
      vapi.start();
    } else {
      alert('Speech recognition not supported in this browser. Please use Chrome, Edge, or Safari.');
    }
  };

  const stopRecording = () => {
    if (vapi && isRecording) {
      vapi.stop();
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div style={styles.appContainer}>
      <div style={styles.container}>
        <div style={styles.header}>
          <div style={styles.headerContent}>
            <div style={styles.headerLeft}>
              <div style={styles.iconBox}>🗄️</div>
              <div>
                <div style={styles.title}>Notion MCP Agent</div>
                <div style={styles.subtitle}>Kimi K2 • Voice + Text • Fireworks AI</div>
              </div>
            </div>
            <div style={styles.statusGroup}>
              <div style={{...styles.status, ...(connected ? styles.connected : styles.disconnected)}}>
                <span>{connected ? '✅' : '❌'}</span>
                <span>{connected ? 'Connected' : 'Disconnected'}</span>
              </div>
              {isRecording && (
                <div style={styles.voiceStatus}>
                  <span>🎙️</span>
                  <span>{callStatus}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {showSetup && (
          <div style={styles.setupPanel}>
            <h2 style={styles.setupTitle}>
              <span>🎯</span> Setup Connection
            </h2>
            <p style={styles.setupDesc}>
              Connect your Notion workspace with voice and text capabilities
            </p>

            <div style={styles.formGroup}>
              <label style={styles.label}>🗄️ Notion Integration Token</label>
              <input
                type="password"
                value={notionKey}
                onChange={(e) => setNotionKey(e.target.value)}
                placeholder="ntn_xxxxxxxxxx or secret_xxxxxxxxxx"
                style={styles.inputField}
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>🔥 Fireworks API Key</label>
              <input
                type="password"
                value={fireworksKey}
                onChange={(e) => setFireworksKey(e.target.value)}
                placeholder="fw_xxxxxxxxxxxxx"
                style={styles.inputField}
              />
            </div>

            <button
              onClick={connectToNotion}
              disabled={loading}
              style={{...styles.btnPrimary, ...(loading && styles.btnDisabled)}}
            >
              {loading ? (
                <>
                  <span style={styles.spinner}></span>
                  Connecting...
                </>
              ) : (
                <>
                  <span>🚀</span>
                  Connect to Notion
                </>
              )}
            </button>
          </div>
        )}

        {connected && (
          <div style={styles.chatContainer}>
            <div style={styles.messagesArea}>
              {messages.map((msg, idx) => (
                <div key={idx} style={{...styles.messageWrapper, ...styles[`messageWrapper${msg.type.charAt(0).toUpperCase() + msg.type.slice(1)}`]}}>
                  <div style={{...styles.message, ...styles[`message${msg.type.charAt(0).toUpperCase() + msg.type.slice(1)}`]}}>
                    <div style={styles.messageContent}>{msg.content}</div>
                    {msg.tools_used && msg.tools_used.length > 0 && (
                      <div style={styles.toolsUsed}>
                        <strong>🔧 Tools:</strong> {msg.tools_used.join(', ')}
                      </div>
                    )}
                    <div style={styles.messageTime}>
                      {msg.timestamp.toLocaleTimeString()}
                      {msg.model && <span style={styles.modelBadge}> • {msg.model}</span>}
                    </div>
                  </div>
                </div>
              ))}

              {loading && (
                <div style={styles.messageWrapperAgent}>
                  <div style={styles.loadingIndicator}>
                    <span style={styles.spinner}></span>
                    <span>Processing...</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div style={styles.inputArea}>
              {/* Voice Controls */}
              <div style={styles.voiceControls}>
                {!isRecording ? (
                  <button
                    onClick={startRecording}
                    style={styles.voiceBtn}
                    title="Start voice input"
                  >
                    <Mic size={20} />
                    <span>Voice Input</span>
                  </button>
                ) : (
                  <button
                    onClick={stopRecording}
                    style={styles.stopBtn}
                    title="Stop recording"
                  >
                    <MicOff size={20} />
                    <span>Stop Recording</span>
                  </button>
                )}
              </div>

              {/* Text Input */}
              <div style={styles.inputRow}>
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder={isRecording ? "Speaking... (text will appear here)" : "Type or use voice input..."}
                  style={styles.chatInput}
                  disabled={loading}
                />
                <button
                  onClick={sendMessage}
                  disabled={loading || !input.trim()}
                  style={{...styles.btnSend, ...((loading || !input.trim()) && styles.btnDisabled)}}
                >
                  📤
                </button>
              </div>

              <div style={styles.quickActions}>
                <button style={styles.quickBtn} onClick={() => setInput('Analyze all my databases and provide insights')}>
                  📊 Deep Analysis
                </button>
                <button style={styles.quickBtn} onClick={() => setInput('Search my entire workspace for information about...')}>
                  🔍 Full Search
                </button>
                <button style={styles.quickBtn} onClick={() => setInput('Summarize all content in my workspace')}>
                  📝 Summary
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  appContainer: {
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '20px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  },
  container: {
    width: '100%',
    maxWidth: '900px',
    background: 'white',
    borderRadius: '16px',
    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
    overflow: 'hidden'
  },
  header: {
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    padding: '24px',
    color: 'white'
  },
  headerContent: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '12px'
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px'
  },
  iconBox: {
    width: '48px',
    height: '48px',
    background: 'rgba(255,255,255,0.2)',
    borderRadius: '12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '24px'
  },
  title: {
    fontSize: '24px',
    fontWeight: 'bold',
    marginBottom: '4px'
  },
  subtitle: {
    fontSize: '14px',
    opacity: 0.9
  },
  statusGroup: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap'
  },
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 16px',
    borderRadius: '8px',
    fontSize: '14px',
    fontWeight: '500'
  },
  connected: {
    background: 'rgba(16, 185, 129, 0.2)',
    border: '1px solid rgba(16, 185, 129, 0.4)'
  },
  disconnected: {
    background: 'rgba(239, 68, 68, 0.2)',
    border: '1px solid rgba(239, 68, 68, 0.4)'
  },
  voiceStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 16px',
    borderRadius: '8px',
    fontSize: '13px',
    fontWeight: '500',
    background: 'rgba(16, 185, 129, 0.3)',
    border: '1px solid rgba(16, 185, 129, 0.5)'
  },
  setupPanel: {
    padding: '32px'
  },
  setupTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    fontSize: '24px',
    marginBottom: '8px',
    color: '#1f2937'
  },
  setupDesc: {
    color: '#6b7280',
    marginBottom: '24px',
    lineHeight: '1.6'
  },
  formGroup: {
    marginBottom: '24px'
  },
  label: {
    display: 'block',
    fontSize: '14px',
    fontWeight: '600',
    color: '#374151',
    marginBottom: '8px'
  },
  inputField: {
    width: '100%',
    padding: '12px 16px',
    border: '2px solid #e5e7eb',
    borderRadius: '8px',
    fontSize: '14px',
    transition: 'all 0.2s',
    boxSizing: 'border-box'
  },
  hint: {
    fontSize: '12px',
    color: '#6b7280',
    marginTop: '6px'
  },
  link: {
    color: '#667eea',
    textDecoration: 'none',
    fontWeight: '500'
  },
  btnPrimary: {
    width: '100%',
    padding: '14px',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontSize: '16px',
    fontWeight: '600',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    transition: 'transform 0.2s'
  },
  btnDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed'
  },
  chatContainer: {
    display: 'flex',
    flexDirection: 'column',
    height: '600px'
  },
  messagesArea: {
    flex: 1,
    overflowY: 'auto',
    padding: '24px',
    background: '#f9fafb'
  },
  messageWrapper: {
    marginBottom: '16px',
    display: 'flex'
  },
  messageWrapperUser: {
    justifyContent: 'flex-end'
  },
  messageWrapperAgent: {
    justifyContent: 'flex-start'
  },
  messageWrapperSystem: {
    justifyContent: 'center'
  },
  message: {
    maxWidth: '75%',
    padding: '12px 16px',
    borderRadius: '12px',
    fontSize: '14px',
    lineHeight: '1.5'
  },
  messageUser: {
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: 'white'
  },
  messageAgent: {
    background: 'white',
    border: '1px solid #e5e7eb',
    color: '#1f2937'
  },
  messageSystem: {
    background: '#fef3c7',
    border: '1px solid #fbbf24',
    color: '#92400e',
    maxWidth: '90%',
    fontSize: '13px'
  },
  messageContent: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word'
  },
  toolsUsed: {
    marginTop: '8px',
    paddingTop: '8px',
    borderTop: '1px solid rgba(0,0,0,0.1)',
    fontSize: '12px',
    color: '#6b7280'
  },
  messageTime: {
    marginTop: '4px',
    fontSize: '11px',
    opacity: 0.6
  },
  modelBadge: {
    fontWeight: '600'
  },
  loadingIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 16px',
    background: 'white',
    border: '1px solid #e5e7eb',
    borderRadius: '12px',
    color: '#6b7280'
  },
  spinner: {
    width: '16px',
    height: '16px',
    border: '2px solid #e5e7eb',
    borderTop: '2px solid #667eea',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite'
  },
  inputArea: {
    padding: '24px',
    background: 'white',
    borderTop: '1px solid #e5e7eb'
  },
  voiceControls: {
    display: 'flex',
    gap: '8px',
    marginBottom: '12px',
    justifyContent: 'center'
  },
  voiceBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 20px',
    background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'transform 0.2s'
  },
  stopBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 20px',
    background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'transform 0.2s',
    animation: 'pulse 2s infinite'
  },
  inputRow: {
    display: 'flex',
    gap: '12px',
    marginBottom: '16px'
  },
  chatInput: {
    flex: 1,
    padding: '12px 16px',
    border: '2px solid #e5e7eb',
    borderRadius: '8px',
    fontSize: '14px',
    transition: 'all 0.2s'
  },
  btnSend: {
    padding: '12px 24px',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontSize: '18px',
    cursor: 'pointer',
    transition: 'transform 0.2s'
  },
  quickActions: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap'
  },
  quickBtn: {
    padding: '8px 12px',
    background: '#f3f4f6',
    border: '1px solid #e5e7eb',
    borderRadius: '6px',
    fontSize: '12px',
    cursor: 'pointer',
    transition: 'all 0.2s',
    color: '#374151'
  }
};

export default App;