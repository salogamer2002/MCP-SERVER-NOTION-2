import React, { useState, useEffect, useRef } from 'react';
import { Send, Plus, Bot, Sparkles, CheckCircle, MessageCircle, Paperclip, X, RefreshCw, Mail, Calendar, FileText, Database } from 'lucide-react';

const API_URL = 'http://localhost:3001';

const GmailIcon = () => (
  <svg viewBox="0 0 24 24" className="w-6 h-6">
    <path fill="#EA4335" d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L12 9.366l8.073-5.873C21.69 2.28 24 3.434 24 5.457z"/>
    <path fill="#FBBC05" d="M0 5.457v13.909L12 12z"/>
    <path fill="#34A853" d="M0 5.457L12 12 24 5.457z"/>
  </svg>
);

const CalendarIcon2 = () => (
  <svg viewBox="0 0 24 24" className="w-6 h-6">
    <path fill="#4285F4" d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z"/>
    <path fill="#EA4335" d="M7 10h5v5H7z"/>
  </svg>
);

const SheetsIcon = () => (
  <svg viewBox="0 0 24 24" className="w-6 h-6">
    <path fill="#0F9D58" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z"/>
    <path fill="#0F9D58" d="M7 7h10v2H7V7zm0 4h10v2H7v-2zm0 4h7v2H7v-2z"/>
  </svg>
);

const DocsIcon = () => (
  <svg viewBox="0 0 24 24" className="w-6 h-6">
    <path fill="#4285F4" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/>
    <path fill="#4285F4" d="M8 15h8v2H8zm0-4h8v2H8zm0-4h5v2H8z"/>
  </svg>
);

const NotionIcon2 = () => (
  <svg viewBox="0 0 24 24" className="w-6 h-6">
    <path fill="#000000" d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933z"/>
  </svg>
);

export default function App() {
  const [activeTab, setActiveTab] = useState('agent');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [messages, setMessages] = useState([]);
  const [currentMessage, setCurrentMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId] = useState(() => `session_${Date.now()}`);
  const [agentAttachments, setAgentAttachments] = useState([]);
  const messagesEndRef = useRef(null);
  const agentFileInputRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleAuth = async () => {
    try {
      const response = await fetch(`${API_URL}/auth/google`);
      const data = await response.json();
      window.open(data.authUrl, '_blank');
      setTimeout(() => setIsAuthenticated(true), 3000);
    } catch (error) {
      console.error('Auth error:', error);
    }
  };

  const handleAgentFileSelect = async (e) => {
    const files = Array.from(e.target.files);
    const filePromises = files.map(file => {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          resolve({
            name: file.name,
            size: file.size,
            type: file.type,
            data: e.target.result.split(',')[1]
          });
        };
        reader.readAsDataURL(file);
      });
    });
    
    const attachments = await Promise.all(filePromises);
    setAgentAttachments(prev => [...prev, ...attachments]);
  };

  const removeAgentAttachment = (index) => {
    setAgentAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const handleSendMessage = async () => {
    if (!currentMessage.trim() && agentAttachments.length === 0) return;

    const userMsg = { 
      role: 'user', 
      content: currentMessage,
      attachments: agentAttachments.length > 0 ? agentAttachments : undefined
    };
    setMessages(prev => [...prev, userMsg]);
    setCurrentMessage('');
    const tempAttachments = [...agentAttachments];
    setAgentAttachments([]);
    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: userMsg.content, 
          sessionId,
          attachments: tempAttachments.length > 0 ? tempAttachments : undefined
        }),
      });

      const data = await response.json();
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.message || data.error,
        success: data.success !== false
      }]);
    } catch (error) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Error: ${error.message}`,
        success: false
      }]);
    }
    setLoading(false);
  };

  const quickActions = [
    { text: 'Send an email', icon: Mail },
    { text: 'Create a calendar event', icon: Calendar },
    { text: 'Create a Google Sheet', icon: FileText },
    { text: 'Create a Google Doc', icon: FileText },
    { text: 'Search Notion pages', icon: Database },
  ];

  const tabs = [
    { id: 'agent', label: 'AI Agent', icon: Bot, color: 'from-purple-600 to-pink-600' },
    { id: 'gmail', label: 'Gmail', icon: GmailIcon, color: 'from-red-500 to-red-600' },
    { id: 'calendar', label: 'Calendar', icon: CalendarIcon2, color: 'from-blue-500 to-blue-600' },
    { id: 'sheets', label: 'Sheets', icon: SheetsIcon, color: 'from-green-500 to-green-600' },
    { id: 'docs', label: 'Docs', icon: DocsIcon, color: 'from-blue-400 to-blue-500' },
    { id: 'notion', label: 'Notion', icon: NotionIcon2, color: 'from-gray-700 to-gray-900' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      <div className="bg-black/30 backdrop-blur-lg border-b border-purple-500/20 sticky top-0 z-50">
        <div className="max-w-[1800px] mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-pink-500 rounded-xl flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white">AI Agent Hub</h1>
                <p className="text-xs text-purple-300">Gmail • Calendar • Sheets • Docs • Notion</p>
              </div>
            </div>
            <div className="flex items-center space-x-3">
              {isAuthenticated && (
                <div className="flex items-center space-x-2 px-4 py-2 bg-green-500/20 rounded-lg border border-green-500/30">
                  <CheckCircle className="w-5 h-5 text-green-400" />
                  <span className="text-green-300 text-sm font-medium">Connected</span>
                </div>
              )}
              <button
                onClick={handleAuth}
                className="px-6 py-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg font-medium hover:from-purple-700 hover:to-pink-700 transition-all shadow-lg"
              >
                {isAuthenticated ? 'Reconnect' : 'Connect Google'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-[1800px] mx-auto px-6 mt-6">
        <div className="grid grid-cols-6 gap-4 bg-black/20 backdrop-blur-lg p-4 rounded-xl border border-purple-500/20">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex flex-col items-center justify-center space-y-2 px-6 py-6 rounded-xl font-medium transition-all ${
                activeTab === tab.id
                  ? `bg-gradient-to-r ${tab.color} text-white shadow-lg scale-105`
                  : 'text-purple-300 hover:bg-white/5 hover:scale-102'
              }`}
            >
              {typeof tab.icon === 'function' ? <tab.icon /> : <tab.icon className="w-6 h-6" />}
              <span className="text-sm font-semibold">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-[1800px] mx-auto px-6 py-8">
        {activeTab === 'agent' && (
          <div className="space-y-6">
            <div className="bg-black/30 backdrop-blur-lg rounded-2xl border border-purple-500/20 overflow-hidden flex flex-col" style={{ height: '700px' }}>
              <div className="px-8 py-6 border-b border-purple-500/20">
                <div className="flex items-center space-x-3">
                  <Bot className="w-8 h-8 text-purple-400" />
                  <div>
                    <h2 className="text-2xl font-bold text-white">AI Assistant</h2>
                    <p className="text-purple-300 text-sm">Ask me to manage Gmail, Calendar, Sheets, Docs, or Notion</p>
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-8 py-6 space-y-4">
                {messages.length === 0 && (
                  <div className="text-center py-12">
                    <MessageCircle className="w-16 h-16 text-purple-400 mx-auto mb-4" />
                    <h3 className="text-xl font-semibold text-white mb-2">Start a conversation</h3>
                    <p className="text-purple-300 mb-6">Try one of these:</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-2xl mx-auto">
                      {quickActions.map((action, i) => (
                        <button
                          key={i}
                          onClick={() => setCurrentMessage(action.text)}
                          className="flex items-center space-x-3 px-4 py-3 bg-slate-800/50 border border-purple-500/30 rounded-xl text-left hover:border-purple-500/50 hover:bg-slate-800/70 transition-all group"
                        >
                          <action.icon className="w-5 h-5 text-purple-400 group-hover:text-purple-300" />
                          <span className="text-purple-200 group-hover:text-white">{action.text}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {messages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-3xl px-6 py-4 rounded-2xl break-words ${
                      msg.role === 'user'
                        ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white'
                        : msg.success === true
                        ? 'bg-green-900/30 border border-green-500/30 text-green-100'
                        : msg.success === false
                        ? 'bg-red-900/30 border border-red-500/30 text-red-100'
                        : 'bg-slate-800/50 border border-purple-500/30 text-purple-100'
                    }`}>
                      <div className="whitespace-pre-wrap break-words overflow-wrap-anywhere">{msg.content}</div>
                      {msg.attachments && (
                        <div className="mt-2 pt-2 border-t border-white/20">
                          {msg.attachments.map((att, j) => (
                            <div key={j} className="text-xs opacity-80 flex items-center gap-1">
                              <Paperclip className="w-3 h-3" />
                              {att.name}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {loading && (
                  <div className="flex justify-start">
                    <div className="bg-slate-800/50 border border-purple-500/30 rounded-2xl px-6 py-4">
                      <div className="flex items-center space-x-2">
                        <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                        <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                        <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                      </div>
                    </div>
                  </div>
                )}
                
                <div ref={messagesEndRef} />
              </div>

              <div className="px-8 py-6 border-t border-purple-500/20">
                {agentAttachments.length > 0 && (
                  <div className="mb-3 bg-slate-800/30 border border-purple-500/20 rounded-lg p-3">
                    <p className="text-xs text-purple-300 mb-2">Attachments ({agentAttachments.length}):</p>
                    <div className="space-y-2">
                      {agentAttachments.map((att, i) => (
                        <div key={i} className="flex items-center justify-between bg-slate-700/30 rounded px-3 py-2">
                          <div className="flex items-center gap-2">
                            <Paperclip className="w-4 h-4 text-purple-400" />
                            <span className="text-sm text-white">{att.name}</span>
                            <span className="text-xs text-purple-300">({(att.size / 1024).toFixed(1)} KB)</span>
                          </div>
                          <button
                            onClick={() => removeAgentAttachment(i)}
                            className="text-red-400 hover:text-red-300"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex space-x-3">
                  <input
                    type="file"
                    ref={agentFileInputRef}
                    onChange={handleAgentFileSelect}
                    multiple
                    className="hidden"
                  />
                  <button
                    onClick={() => agentFileInputRef.current?.click()}
                    className="p-3 bg-purple-600/20 border border-purple-500/30 rounded-xl hover:bg-purple-600/30 transition-all"
                    title="Attach files"
                  >
                    <Paperclip className="w-5 h-5 text-purple-400" />
                  </button>
                  <input
                    type="text"
                    value={currentMessage}
                    onChange={e => setCurrentMessage(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSendMessage()}
                    placeholder="Type your message..."
                    className="flex-1 bg-slate-800/50 border border-purple-500/30 rounded-xl px-4 py-3 text-white placeholder-purple-300/50 focus:outline-none focus:ring-2 focus:ring-purple-500"
                    disabled={loading}
                  />
                  <button
                    onClick={handleSendMessage}
                    disabled={loading || (!currentMessage.trim() && agentAttachments.length === 0)}
                    className="px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-xl font-medium hover:from-purple-700 hover:to-pink-700 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Send className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab !== 'agent' && (
          <div className="bg-black/30 backdrop-blur-lg rounded-2xl border border-purple-500/20 p-16 text-center">
            {activeTab === 'gmail' && <GmailIcon />}
            {activeTab === 'calendar' && <CalendarIcon2 />}
            {activeTab === 'sheets' && <SheetsIcon />}
            {activeTab === 'docs' && <DocsIcon />}
            {activeTab === 'notion' && <NotionIcon2 />}
            <div className="mt-8">
              <h3 className="text-3xl font-bold text-white mb-4">Use the AI Agent</h3>
              <p className="text-xl text-purple-300 mb-8">
                All {activeTab} features are available through the AI Agent
              </p>
              <button
                onClick={() => setActiveTab('agent')}
                className="px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-xl font-medium hover:from-purple-700 hover:to-pink-700 transition-all shadow-lg text-lg"
              >
                Go to AI Agent
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}