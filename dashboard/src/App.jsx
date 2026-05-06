import { useEffect, useMemo, useState } from 'react'
import {
    Bar,
    BarChart,
    CartesianGrid,
    Legend,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts'
import './App.css'

const TICKERS = ['VALE3.SA', 'PETR4.SA', 'ITUB4.SA']

const TICKER_INFO = {
    'VALE3.SA': { icon: '⛏️', nome: 'Vale' },
    'PETR4.SA': { icon: '🛢️', nome: 'Petrobras' },
    'ITUB4.SA': { icon: '🏦', nome: 'Itaú' },
}

const TICKER_COLORS = {
    'VALE3.SA': '#34d399',
    'PETR4.SA': '#f59e0b',
    'ITUB4.SA': '#60a5fa',
}

const CSV_FILES = {
    precos: 'precos_fechamento.csv',
    retornos: 'retornos_logaritmicos.csv',
    riscoHistorico: 'metricas_risco.csv',
    riscoMonteCarlo: 'metricas_risco_monte_carlo.csv',
    riscoComparativo: 'metricas_risco_comparativo.csv',
    monteCarloResumo: 'monte_carlo_gbm_resumo.csv',
}

function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/)
    if (lines.length === 0) return []

    const headers = lines[0].split(',').map((item) => item.trim())
    return lines
        .slice(1)
        .filter(Boolean)
        .map((line) => {
            const values = line.split(',')
            return headers.reduce((row, header, idx) => {
                row[header || 'index'] = values[idx]?.trim() ?? ''
                return row
            }, {})
        })
}

function toNumber(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

function formatNumber(value, digits = 4) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—'
    return Number(value).toLocaleString('pt-BR', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    })
}

function metricsToCards(metrics) {
    return Object.entries(metrics).map(([label, value]) => ({ label, value }))
}

function App() {
    const [activeTab, setActiveTab] = useState(TICKERS[0])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [data, setData] = useState(null)
    const [noticias, setNoticias] = useState([])
    const [noticiasFiltro, setNoticiasFiltro] = useState('TODAS')

    useEffect(() => {
        async function loadData() {
            try {
                setLoading(true)
                setError('')

                const responses = await Promise.all(Object.values(CSV_FILES).map((file) => fetch(`/data/${file}`)))
                if (responses.some((response) => !response.ok)) {
                    throw new Error('Não foi possível carregar os CSVs em public/data.')
                }

                const [precosTxt, retornosTxt, riscoHistoricoTxt, riscoMonteCarloTxt, riscoComparativoTxt, monteCarloResumoTxt] =
                    await Promise.all(responses.map((response) => response.text()))

                setData({
                    precos: parseCsv(precosTxt),
                    retornos: parseCsv(retornosTxt),
                    riscoHistorico: parseCsv(riscoHistoricoTxt),
                    riscoMonteCarlo: parseCsv(riscoMonteCarloTxt),
                    riscoComparativo: parseCsv(riscoComparativoTxt),
                    monteCarloResumo: parseCsv(monteCarloResumoTxt),
                })

                try {
                    const resp = await fetch('/data/noticias.json')
                    if (resp.ok) {
                        const json = await resp.json()
                        setNoticias(Array.isArray(json) ? json : [])
                    }
                } catch {
                    setNoticias([])
                }
            } catch (loadError) {
                setError(loadError.message)
            } finally {
                setLoading(false)
            }
        }

        loadData()
    }, [])

    const analytics = useMemo(() => {
        if (!data) return null

        const statsRetornos = {}
        const seriePrecos = {}

        TICKERS.forEach((ticker) => {
            const byQuarter = {}

            data.precos.forEach((row) => {
                const preco = toNumber(row[ticker])
                if (preco === null) return

                const dateStr = row.Date || row.index || ''
                const parts = dateStr.split('-')
                const year = parseInt(parts[0], 10)
                const month = parseInt(parts[1], 10)
                if (!Number.isFinite(year) || !Number.isFinite(month)) return

                const q = Math.ceil(month / 3)
                const key = `${year}-Q${q}`
                if (!byQuarter[key]) byQuarter[key] = { sum: 0, count: 0, sort: year * 10 + q }
                byQuarter[key].sum += preco
                byQuarter[key].count += 1
            })

            seriePrecos[ticker] = Object.entries(byQuarter)
                .sort((a, b) => a[1].sort - b[1].sort)
                .map(([label, { sum, count }]) => ({
                    trimestre: label,
                    preco: sum / count,
                }))
        })

        TICKERS.forEach((ticker) => {
            const series = data.retornos.map((row) => toNumber(row[ticker])).filter((value) => value !== null)
            const media = series.reduce((sum, value) => sum + value, 0) / Math.max(series.length, 1)
            const variancia = series.reduce((sum, value) => sum + (value - media) ** 2, 0) / Math.max(series.length - 1, 1)

            statsRetornos[ticker] = {
                media_retorno_log_5y: media,
                desvio_padrao_retorno_log_5y: Math.sqrt(variancia),
            }
        })

        const porTicker = {}

        TICKERS.forEach((ticker) => {
            const historico = data.riscoHistorico.find((row) => row.index === ticker) ?? {}
            const monteCarlo = data.riscoMonteCarlo.find((row) => row.index === ticker) ?? {}
            const resumo = data.monteCarloResumo.find((row) => row.index === ticker) ?? {}

            porTicker[ticker] = {
                ...statsRetornos[ticker],
                var_historico_95: toNumber(historico.var_historico_95),
                cvar_historico_95: toNumber(historico.cvar_historico_95),
                drawdown_maximo_historico: toNumber(historico.drawdown_maximo),
                sharpe_historico: toNumber(historico.indice_sharpe_anualizado),
                kurtosis_historico: toNumber(historico.kurtosis),
                z_score_historico: toNumber(historico.z_score_ultimo_retorno),
                var_monte_carlo_95: toNumber(monteCarlo.var_monte_carlo_95),
                cvar_monte_carlo_95: toNumber(monteCarlo.cvar_monte_carlo_95),
                drawdown_maximo_monte_carlo: toNumber(monteCarlo.drawdown_maximo_medio),
                sharpe_monte_carlo: toNumber(monteCarlo.indice_sharpe_anualizado),
                kurtosis_monte_carlo: toNumber(monteCarlo.kurtosis),
                z_score_monte_carlo: toNumber(monteCarlo.z_score_ultimo_retorno_terminal),
                media_preco_final_mc: toNumber(resumo.media_preco_final),
                mediana_preco_final_mc: toNumber(resumo.mediana_preco_final),
                percentil_5_preco_final_mc: toNumber(resumo.percentil_5),
                percentil_95_preco_final_mc: toNumber(resumo.percentil_95),
            }
        })

        const comparativo = data.riscoComparativo.map((row) => {
            const ticker = row.index
            const resumo = data.monteCarloResumo.find((item) => item.index === ticker) ?? {}

            return {
                ativo: ticker,
                media_retorno_log_5y: statsRetornos[ticker]?.media_retorno_log_5y ?? null,
                desvio_padrao_retorno_log_5y: statsRetornos[ticker]?.desvio_padrao_retorno_log_5y ?? null,
                var_95_historico: toNumber(row.var_95_historico),
                var_95_monte_carlo: toNumber(row.var_95_monte_carlo),
                cvar_95_historico: toNumber(row.cvar_95_historico),
                cvar_95_monte_carlo: toNumber(row.cvar_95_monte_carlo),
                drawdown_maximo_historico: toNumber(row.drawdown_maximo_historico),
                drawdown_maximo_monte_carlo: toNumber(row.drawdown_maximo_monte_carlo),
                sharpe_historico: toNumber(row.indice_sharpe_anualizado_historico),
                sharpe_monte_carlo: toNumber(row.indice_sharpe_anualizado_monte_carlo),
                kurtosis_historico: toNumber(row.kurtosis_historico),
                kurtosis_monte_carlo: toNumber(row.kurtosis_monte_carlo),
                z_score_historico: toNumber(row.z_score_historico),
                z_score_monte_carlo: toNumber(row.z_score_monte_carlo),
                media_preco_final_mc: toNumber(resumo.media_preco_final),
                mediana_preco_final_mc: toNumber(resumo.mediana_preco_final),
                percentil_5_preco_final_mc: toNumber(resumo.percentil_5),
                percentil_95_preco_final_mc: toNumber(resumo.percentil_95),
            }
        })

        const allQuartersSet = new Set()
        TICKERS.forEach((ticker) => (seriePrecos[ticker] ?? []).forEach((p) => allQuartersSet.add(p.trimestre)))

        const serieComparativa = [...allQuartersSet].sort().map((trimestre) => {
            const point = { trimestre }
            TICKERS.forEach((ticker) => {
                const found = (seriePrecos[ticker] ?? []).find((p) => p.trimestre === trimestre)
                point[ticker] = found ? Number(found.preco.toFixed(2)) : null
            })
            return point
        })

        const scoreData = TICKERS.map((ticker) => {
            const c = comparativo.find((r) => r.ativo === ticker) ?? {}
            return {
                ticker,
                sharpe: ((c.sharpe_historico ?? 0) + (c.sharpe_monte_carlo ?? 0)) / 2,
                vari: ((c.var_95_historico ?? 1) + (c.var_95_monte_carlo ?? 1)) / 2,
                dd: ((c.drawdown_maximo_historico ?? 1) + (c.drawdown_maximo_monte_carlo ?? 1)) / 2,
            }
        })

        const rankBy = (arr, key, asc) => {
            const sorted = [...arr].sort((a, b) => (asc ? a[key] - b[key] : b[key] - a[key]))
            return Object.fromEntries(sorted.map((item, i) => [item.ticker, i + 1]))
        }

        const rankSharpe = rankBy(scoreData, 'sharpe', false)
        const rankVar = rankBy(scoreData, 'vari', true)
        const rankDd = rankBy(scoreData, 'dd', true)

        const scored = TICKERS.map((ticker) => {
            const item = scoreData.find((s) => s.ticker === ticker)
            return {
                ticker,
                rankSum: rankSharpe[ticker] + rankVar[ticker] + rankDd[ticker],
                sharpe: item.sharpe,
                vari: item.vari,
                dd: item.dd,
            }
        }).sort((a, b) => a.rankSum - b.rankSum)

        return {
            porTicker,
            comparativo,
            seriePrecos,
            serieComparativa,
            melhorAtivo: scored[0],
            scored,
        }
    }, [data])

    const comparisonColumns = [
        ['media_retorno_log_5y', 'Média Retorno Log 5Y'],
        ['desvio_padrao_retorno_log_5y', 'Desvio Padrão 5Y'],
        ['var_95_historico', 'VaR 95% Hist'],
        ['var_95_monte_carlo', 'VaR 95% MC'],
        ['cvar_95_historico', 'CVaR 95% Hist'],
        ['cvar_95_monte_carlo', 'CVaR 95% MC'],
        ['drawdown_maximo_historico', 'Drawdown Hist'],
        ['drawdown_maximo_monte_carlo', 'Drawdown MC'],
        ['sharpe_historico', 'Sharpe Hist'],
        ['sharpe_monte_carlo', 'Sharpe MC'],
        ['kurtosis_historico', 'Kurtosis Hist'],
        ['kurtosis_monte_carlo', 'Kurtosis MC'],
        ['z_score_historico', 'Z-Score Hist'],
        ['z_score_monte_carlo', 'Z-Score MC'],
        ['media_preco_final_mc', 'Média Preço Final MC'],
        ['mediana_preco_final_mc', 'Mediana Preço Final MC'],
        ['percentil_5_preco_final_mc', 'P5 Preço Final MC'],
        ['percentil_95_preco_final_mc', 'P95 Preço Final MC'],
    ]

    const selectedAssetMetrics = analytics?.porTicker[activeTab] ?? {}
    const selectedPriceSeries = analytics?.seriePrecos[activeTab] ?? []

    const selectedRiskBars = useMemo(() => {
        if (!selectedAssetMetrics || activeTab === 'COMPARATIVO' || activeTab === 'NOTICIAS') return []

        return [
            {
                metrica: 'VaR 95%',
                historico: selectedAssetMetrics.var_historico_95,
                monteCarlo: selectedAssetMetrics.var_monte_carlo_95,
            },
            {
                metrica: 'CVaR 95%',
                historico: selectedAssetMetrics.cvar_historico_95,
                monteCarlo: selectedAssetMetrics.cvar_monte_carlo_95,
            },
            {
                metrica: 'Sharpe',
                historico: selectedAssetMetrics.sharpe_historico,
                monteCarlo: selectedAssetMetrics.sharpe_monte_carlo,
            },
            {
                metrica: 'Drawdown',
                historico: selectedAssetMetrics.drawdown_maximo_historico,
                monteCarlo: selectedAssetMetrics.drawdown_maximo_monte_carlo,
            },
        ]
    }, [selectedAssetMetrics, activeTab])

    const selectedMonteCarloSummary = useMemo(() => {
        if (!selectedAssetMetrics || activeTab === 'COMPARATIVO' || activeTab === 'NOTICIAS') return []

        return [
            { nome: 'P5', valor: selectedAssetMetrics.percentil_5_preco_final_mc },
            { nome: 'Mediana', valor: selectedAssetMetrics.mediana_preco_final_mc },
            { nome: 'Média', valor: selectedAssetMetrics.media_preco_final_mc },
            { nome: 'P95', valor: selectedAssetMetrics.percentil_95_preco_final_mc },
        ]
    }, [selectedAssetMetrics, activeTab])

    const comparisonRiskBars = useMemo(() => {
        if (!analytics?.comparativo) return []

        return analytics.comparativo.map((row) => ({
            ativo: row.ativo,
            varHist: row.var_95_historico,
            varMc: row.var_95_monte_carlo,
            cvarHist: row.cvar_95_historico,
            sharpeHist: row.sharpe_historico,
            sharpeMc: row.sharpe_monte_carlo,
        }))
    }, [analytics])

    return (
        <main className="dashboard">
            <header className="dashboard-header">
                <h1>Dashboard de Métricas de Ativos</h1>
                <p>Dados dos últimos 5 anos PETR4, VALE3 e ITUB4.</p>
            </header>

            <nav className="tabs">
                {TICKERS.map((ticker) => (
                    <button
                        key={ticker}
                        type="button"
                        className={activeTab === ticker ? 'tab active' : 'tab'}
                        onClick={() => setActiveTab(ticker)}
                        title={ticker}
                    >
                        <span className="tab-icon">{TICKER_INFO[ticker].icon}</span>
                        <span className="tab-label">{TICKER_INFO[ticker].nome}</span>
                    </button>
                ))}

                <button
                    type="button"
                    className={activeTab === 'COMPARATIVO' ? 'tab active' : 'tab'}
                    onClick={() => setActiveTab('COMPARATIVO')}
                >
                    <span className="tab-icon">📊</span>
                    <span className="tab-label">Comparativo</span>
                </button>

                <button
                    type="button"
                    className={activeTab === 'NOTICIAS' ? 'tab active' : 'tab'}
                    onClick={() => setActiveTab('NOTICIAS')}
                >
                    <span className="tab-icon">📰</span>
                    <span className="tab-label">Notícias</span>
                </button>
            </nav>

            {loading && <p className="status">Carregando dados...</p>}
            {error && <p className="status error">{error}</p>}

            {!loading && !error && activeTab !== 'COMPARATIVO' && activeTab !== 'NOTICIAS' && (
                <section className="asset-panel">
                    <h2>
                        {TICKER_INFO[activeTab]?.icon} {TICKER_INFO[activeTab]?.nome}{' '}
                        <span className="ticker-code">({activeTab})</span>
                    </h2>

                    <div className="charts-grid">
                        <article className="chart-card">
                            <h3>Preço Médio Trimestral (5 anos)</h3>
                            <ResponsiveContainer width="100%" height={260}>
                                <LineChart data={selectedPriceSeries}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                                    <XAxis
                                        dataKey="trimestre"
                                        tick={{ fontSize: 10, fill: '#94a3b8' }}
                                        interval={3}
                                        angle={-35}
                                        textAnchor="end"
                                        height={45}
                                    />
                                    <YAxis tickFormatter={(value) => `R$ ${value.toFixed(0)}`} />
                                    <Tooltip
                                        labelFormatter={(label) => label}
                                        formatter={(value) => [`R$ ${formatNumber(value, 2)}`, 'Preço médio']}
                                    />
                                    <Line type="monotone" dataKey="preco" stroke="#38bdf8" dot={{ r: 3, fill: '#38bdf8' }} strokeWidth={2} />
                                </LineChart>
                            </ResponsiveContainer>
                        </article>

                        <article className="chart-card">
                            <h3>Risco: Histórico x Monte Carlo</h3>
                            <ResponsiveContainer width="100%" height={260}>
                                <BarChart data={selectedRiskBars}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                                    <XAxis dataKey="metrica" />
                                    <YAxis />
                                    <Tooltip formatter={(value) => formatNumber(value)} />
                                    <Legend />
                                    <Bar dataKey="historico" fill="#60a5fa" name="Histórico" />
                                    <Bar dataKey="monteCarlo" fill="#f59e0b" name="Monte Carlo" />
                                </BarChart>
                            </ResponsiveContainer>
                        </article>

                        <article className="chart-card">
                            <h3>Resumo de Preço Final (Monte Carlo)</h3>
                            <ResponsiveContainer width="100%" height={260}>
                                <BarChart data={selectedMonteCarloSummary}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                                    <XAxis dataKey="nome" />
                                    <YAxis />
                                    <Tooltip formatter={(value) => formatNumber(value, 2)} />
                                    <Bar dataKey="valor" fill="#34d399" />
                                </BarChart>
                            </ResponsiveContainer>
                        </article>
                    </div>

                    <div className="cards-grid">
                        {metricsToCards(selectedAssetMetrics).map((item) => (
                            <article className="metric-card" key={item.label}>
                                <p className="metric-label">{item.label.replaceAll('_', ' ')}</p>
                                <p className="metric-value">{formatNumber(item.value)}</p>
                            </article>
                        ))}
                    </div>
                </section>
            )}

            {!loading && !error && activeTab === 'NOTICIAS' && (
                <section className="noticias-panel">
                    <h2>📰 Notícias da Última Semana</h2>

                    <div className="noticias-filtros">
                        {['TODAS', ...TICKERS].map((filtro) => (
                            <button
                                key={filtro}
                                type="button"
                                className={noticiasFiltro === filtro ? 'filtro-btn active' : 'filtro-btn'}
                                onClick={() => setNoticiasFiltro(filtro)}
                            >
                                {filtro === 'TODAS' ? '🌐 Todas' : `${TICKER_INFO[filtro]?.icon} ${TICKER_INFO[filtro]?.nome}`}
                            </button>
                        ))}
                    </div>

                    {noticias.length === 0 ? (
                        <p className="status">Nenhuma notícia encontrada. Execute o pipeline Python e sincronize os dados.</p>
                    ) : (
                        <div className="noticias-grid">
                            {noticias
                                .filter((n) => noticiasFiltro === 'TODAS' || n.ticker === noticiasFiltro)
                                .map((n, i) => (
                                    <a
                                        key={`${n.ticker}-${n.timestamp}-${i}`}
                                        href={n.url || '#'}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="noticia-card"
                                        style={{ '--ticker-color': TICKER_COLORS[n.ticker] ?? '#94a3b8' }}
                                    >
                                        <div className="noticia-header">
                                            <span className="noticia-ticker-badge" style={{ background: TICKER_COLORS[n.ticker] ?? '#334155' }}>
                                                {TICKER_INFO[n.ticker]?.icon} {n.ticker}
                                            </span>
                                            <span className="noticia-data">{n.data}</span>
                                        </div>
                                        <p className="noticia-titulo">{n.titulo}</p>
                                        <p className="noticia-publicador">{n.publicador || 'Fonte não informada'}</p>
                                    </a>
                                ))}
                        </div>
                    )}
                </section>
            )}

            {!loading && !error && activeTab === 'COMPARATIVO' && (
                <section className="comparison-panel">
                    <h2>Comparação Total dos 3 Ativos</h2>

                    <div className="charts-grid comparative">
                        <article className="chart-card full-width">
                            <h3>Preço Médio Trimestral — Comparativo (5 anos)</h3>
                            <ResponsiveContainer width="100%" height={280}>
                                <LineChart data={analytics?.serieComparativa ?? []}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                                    <XAxis
                                        dataKey="trimestre"
                                        tick={{ fontSize: 10, fill: '#94a3b8' }}
                                        interval={3}
                                        angle={-35}
                                        textAnchor="end"
                                        height={45}
                                    />
                                    <YAxis tickFormatter={(v) => `R$ ${v.toFixed(0)}`} />
                                    <Tooltip
                                        labelFormatter={(l) => l}
                                        formatter={(value, name) => [`R$ ${formatNumber(value, 2)}`, `${TICKER_INFO[name]?.icon ?? ''} ${name}`]}
                                    />
                                    <Legend formatter={(value) => `${TICKER_INFO[value]?.icon ?? ''} ${value}`} />
                                    {TICKERS.map((ticker) => (
                                        <Line
                                            key={ticker}
                                            type="monotone"
                                            dataKey={ticker}
                                            stroke={TICKER_COLORS[ticker]}
                                            dot={false}
                                            strokeWidth={2}
                                            connectNulls
                                        />
                                    ))}
                                </LineChart>
                            </ResponsiveContainer>
                        </article>

                        <article className="chart-card">
                            <h3>VaR 95% por Ativo</h3>
                            <ResponsiveContainer width="100%" height={260}>
                                <BarChart data={comparisonRiskBars}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                                    <XAxis dataKey="ativo" />
                                    <YAxis />
                                    <Tooltip formatter={(value) => formatNumber(value)} />
                                    <Legend />
                                    <Bar dataKey="varHist" fill="#60a5fa" name="VaR Hist" />
                                    <Bar dataKey="varMc" fill="#f97316" name="VaR MC" />
                                </BarChart>
                            </ResponsiveContainer>
                        </article>

                        <article className="chart-card">
                            <h3>Sharpe por Ativo</h3>
                            <ResponsiveContainer width="100%" height={260}>
                                <BarChart data={comparisonRiskBars}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                                    <XAxis dataKey="ativo" />
                                    <YAxis />
                                    <Tooltip formatter={(value) => formatNumber(value)} />
                                    <Legend />
                                    <Bar dataKey="sharpeHist" fill="#22c55e" name="Sharpe Hist" />
                                    <Bar dataKey="sharpeMc" fill="#eab308" name="Sharpe MC" />
                                </BarChart>
                            </ResponsiveContainer>
                        </article>

                        <article className="chart-card">
                            <h3>CVaR Histórico 95% por Ativo</h3>
                            <ResponsiveContainer width="100%" height={260}>
                                <BarChart data={comparisonRiskBars}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                                    <XAxis dataKey="ativo" />
                                    <YAxis />
                                    <Tooltip formatter={(value) => formatNumber(value)} />
                                    <Legend />
                                    <Bar dataKey="cvarHist" fill="#a78bfa" name="CVaR Hist 95%" />
                                </BarChart>
                            </ResponsiveContainer>
                        </article>
                    </div>

                    {analytics?.melhorAtivo && (
                        <article className="recommendation-card">
                            <div className="rec-badge">💡 Sugestão de Investimento</div>
                            <div className="rec-body">
                                <span className="rec-icon">{TICKER_INFO[analytics.melhorAtivo.ticker]?.icon}</span>
                                <div className="rec-info">
                                    <h3>
                                        {TICKER_INFO[analytics.melhorAtivo.ticker]?.nome}{' '}
                                        <span className="ticker-code">({analytics.melhorAtivo.ticker})</span>
                                    </h3>
                                    <p>
                                        Melhor relação risco-retorno entre os 3 ativos com base em Sharpe médio,
                                        VaR 95% e Drawdown máximo (histórico + Monte Carlo).
                                    </p>
                                    <div className="rec-metrics">
                                        {analytics.scored.map((s, i) => (
                                            <div key={s.ticker} className={`rec-metric-row${s.ticker === analytics.melhorAtivo.ticker ? ' best' : ''}`}>
                                                <span>
                                                    {TICKER_INFO[s.ticker]?.icon} {s.ticker}
                                                </span>
                                                <span>Sharpe: {formatNumber(s.sharpe, 3)}</span>
                                                <span>VaR: {formatNumber(s.vari, 4)}</span>
                                                <span>Drawdown: {formatNumber(s.dd, 4)}</span>
                                                <span className="rank-badge">#{i + 1}º</span>
                                            </div>
                                        ))}
                                    </div>
                                    <p className="rec-disclaimer">
                                        ⚠️ Esta sugestão é baseada em dados históricos e simulações estatísticas. Não constitui recomendação financeira profissional.
                                    </p>
                                </div>
                            </div>
                        </article>
                    )}

                    <div className="table-wrap">
                        <table>
                            <thead>
                                <tr>
                                    <th>Ativo</th>
                                    {comparisonColumns.map(([key, label]) => (
                                        <th key={key}>{label}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {analytics?.comparativo.map((row) => (
                                    <tr key={row.ativo}>
                                        <td>{row.ativo}</td>
                                        {comparisonColumns.map(([key]) => (
                                            <td key={key}>{formatNumber(row[key])}</td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}
        </main>
    )
}

export default App
