import json
import numpy as np
import pandas as pd
import yfinance as yf
import matplotlib.pyplot as plt
from datetime import datetime, timezone
from pathlib import Path


def baixar_precos_fechamento(tickers: list[str], period: str = "5y") -> pd.DataFrame:
    dados = yf.download(tickers, period=period, auto_adjust=True, progress=False)
    precos = dados["Close"].copy()

    if isinstance(precos, pd.Series):
        precos = precos.to_frame(name=tickers[0])

    precos = precos.dropna(how="all")
    return precos


def calcular_retornos_log(precos: pd.DataFrame) -> pd.DataFrame:
    retornos_log = np.log(precos / precos.shift(1))
    return retornos_log.dropna(how="all")


def calcular_volatilidade_historica(retornos_log: pd.DataFrame, janela: int = 21) -> pd.DataFrame:
    volatilidade_diaria = retornos_log.rolling(window=janela).std()
    volatilidade_anualizada = volatilidade_diaria * np.sqrt(252)
    return volatilidade_anualizada.dropna(how="all")


def calcular_matriz_correlacao(retornos_log: pd.DataFrame) -> pd.DataFrame:
    return retornos_log.corr()


def estimar_parametros_gbm(retornos_log: pd.DataFrame) -> tuple[pd.Series, pd.Series, pd.DataFrame]:
    mu_diario = retornos_log.mean()
    sigma_diario = retornos_log.std()
    correlacao = retornos_log.corr()
    return mu_diario, sigma_diario, correlacao


def simular_monte_carlo_gbm_multivariado(
    precos: pd.DataFrame,
    mu_diario: pd.Series,
    sigma_diario: pd.Series,
    correlacao: pd.DataFrame,
    dias: int = 252,
    n_simulacoes: int = 1000,
    seed: int = 42,
) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    tickers = list(precos.columns)
    n_ativos = len(tickers)
    dt = 1.0

    ultimo_preco = precos.iloc[-1].to_numpy(dtype=float)
    mu = mu_diario.reindex(tickers).to_numpy(dtype=float)
    sigma = sigma_diario.reindex(tickers).to_numpy(dtype=float)
    matriz_correlacao = correlacao.reindex(index=tickers, columns=tickers).to_numpy(dtype=float)
    cholesky = np.linalg.cholesky(matriz_correlacao)

    simulacoes = {ticker: np.zeros((dias + 1, n_simulacoes), dtype=float) for ticker in tickers}

    for idx, ticker in enumerate(tickers):
        simulacoes[ticker][0, :] = ultimo_preco[idx]

    for t in range(1, dias + 1):
        choques = rng.standard_normal((n_ativos, n_simulacoes))
        choques_correlacionados = cholesky @ choques

        for idx, ticker in enumerate(tickers):
            drift = (mu[idx] - 0.5 * sigma[idx] ** 2) * dt
            difusao = sigma[idx] * np.sqrt(dt) * choques_correlacionados[idx, :]
            simulacoes[ticker][t, :] = simulacoes[ticker][t - 1, :] * np.exp(drift + difusao)

    return simulacoes


def resumir_simulacao_precos_finais(simulacoes: dict[str, np.ndarray]) -> pd.DataFrame:
    resumo = {}

    for ticker, trilhas in simulacoes.items():
        precos_finais = trilhas[-1, :]
        resumo[ticker] = {
            "media_preco_final": float(np.mean(precos_finais)),
            "mediana_preco_final": float(np.median(precos_finais)),
            "percentil_5": float(np.percentile(precos_finais, 5)),
            "percentil_95": float(np.percentile(precos_finais, 95)),
        }

    return pd.DataFrame(resumo).T


def calcular_metricas_risco(
    retornos_log: pd.DataFrame,
    precos: pd.DataFrame,
    nivel_confianca: float = 0.95,
    taxa_livre_risco_anual: float = 0.0,
) -> pd.DataFrame:
    alpha = 1.0 - nivel_confianca
    taxa_livre_risco_diaria = taxa_livre_risco_anual / 252
    metricas = {}

    for ticker in retornos_log.columns:
        serie_retorno = retornos_log[ticker].dropna()
        serie_preco = precos[ticker].dropna()

        if serie_retorno.empty or serie_preco.empty:
            continue

        quantil = float(serie_retorno.quantile(alpha))
        perdas_extremas = serie_retorno[serie_retorno <= quantil]

        var_historico = -quantil
        cvar_historico = -float(perdas_extremas.mean()) if not perdas_extremas.empty else np.nan

        retorno_acumulado = np.exp(serie_retorno.cumsum())
        pico = retorno_acumulado.cummax()
        drawdown = (retorno_acumulado / pico) - 1.0
        drawdown_maximo = float(drawdown.min())

        media_excesso = float((serie_retorno - taxa_livre_risco_diaria).mean())
        desvio = float(serie_retorno.std())
        sharpe = (media_excesso / desvio) * np.sqrt(252) if desvio > 0 else np.nan

        kurtosis = float(serie_retorno.kurt())
        ultimo_retorno = float(serie_retorno.iloc[-1])
        media_retorno = float(serie_retorno.mean())
        z_score = (ultimo_retorno - media_retorno) / desvio if desvio > 0 else np.nan

        metricas[ticker] = {
            "var_historico_95": var_historico,
            "cvar_historico_95": cvar_historico,
            "drawdown_maximo": drawdown_maximo,
            "indice_sharpe_anualizado": sharpe,
            "kurtosis": kurtosis,
            "z_score_ultimo_retorno": z_score,
        }

    return pd.DataFrame(metricas).T


def calcular_metricas_risco_monte_carlo(
    simulacoes: dict[str, np.ndarray],
    nivel_confianca: float = 0.95,
    taxa_livre_risco_anual: float = 0.0,
) -> pd.DataFrame:
    alpha = 1.0 - nivel_confianca
    taxa_livre_risco_diaria = taxa_livre_risco_anual / 252
    metricas = {}

    for ticker, trilhas in simulacoes.items():
        precos_iniciais = trilhas[0, :]
        precos_finais = trilhas[-1, :]
        retornos_finais = (precos_finais / precos_iniciais) - 1.0

        quantil = float(np.quantile(retornos_finais, alpha))
        perdas_extremas = retornos_finais[retornos_finais <= quantil]
        var_mc = -quantil
        cvar_mc = -float(np.mean(perdas_extremas)) if perdas_extremas.size > 0 else np.nan

        picos = np.maximum.accumulate(trilhas, axis=0)
        drawdowns = (trilhas / picos) - 1.0
        drawdown_max_por_trilha = np.min(drawdowns, axis=0)
        drawdown_maximo = float(np.mean(drawdown_max_por_trilha))

        retornos_diarios = np.log(trilhas[1:, :] / trilhas[:-1, :]).reshape(-1)
        media_excesso = float(np.mean(retornos_diarios - taxa_livre_risco_diaria))
        desvio = float(np.std(retornos_diarios, ddof=1))
        sharpe = (media_excesso / desvio) * np.sqrt(252) if desvio > 0 else np.nan

        media = float(np.mean(retornos_diarios))
        m2 = float(np.mean((retornos_diarios - media) ** 2))
        m4 = float(np.mean((retornos_diarios - media) ** 4))
        kurtosis = (m4 / (m2 ** 2)) - 3.0 if m2 > 0 else np.nan

        media_terminal = float(np.mean(retornos_finais))
        desvio_terminal = float(np.std(retornos_finais, ddof=1))
        z_score = (retornos_finais[-1] - media_terminal) / desvio_terminal if desvio_terminal > 0 else np.nan

        metricas[ticker] = {
            "var_monte_carlo_95": var_mc,
            "cvar_monte_carlo_95": cvar_mc,
            "drawdown_maximo_medio": drawdown_maximo,
            "indice_sharpe_anualizado": sharpe,
            "kurtosis": kurtosis,
            "z_score_ultimo_retorno_terminal": float(z_score),
        }

    return pd.DataFrame(metricas).T


def construir_relatorio_comparativo_risco(
    metricas_historicas: pd.DataFrame,
    metricas_monte_carlo: pd.DataFrame,
) -> pd.DataFrame:
    mapa_historico = {
        "var_historico_95": "var_95",
        "cvar_historico_95": "cvar_95",
        "drawdown_maximo": "drawdown_maximo",
        "indice_sharpe_anualizado": "indice_sharpe_anualizado",
        "kurtosis": "kurtosis",
        "z_score_ultimo_retorno": "z_score",
    }
    mapa_monte_carlo = {
        "var_monte_carlo_95": "var_95",
        "cvar_monte_carlo_95": "cvar_95",
        "drawdown_maximo_medio": "drawdown_maximo",
        "indice_sharpe_anualizado": "indice_sharpe_anualizado",
        "kurtosis": "kurtosis",
        "z_score_ultimo_retorno_terminal": "z_score",
    }

    historico = metricas_historicas.rename(columns=mapa_historico)
    monte_carlo = metricas_monte_carlo.rename(columns=mapa_monte_carlo)

    base = historico.join(monte_carlo, how="inner", lsuffix="_historico", rsuffix="_monte_carlo")
    colunas_ordenadas = [
        "var_95_historico",
        "var_95_monte_carlo",
        "cvar_95_historico",
        "cvar_95_monte_carlo",
        "drawdown_maximo_historico",
        "drawdown_maximo_monte_carlo",
        "indice_sharpe_anualizado_historico",
        "indice_sharpe_anualizado_monte_carlo",
        "kurtosis_historico",
        "kurtosis_monte_carlo",
        "z_score_historico",
        "z_score_monte_carlo",
    ]
    return base[colunas_ordenadas]


def gerar_fan_chart_monte_carlo(
    simulacoes: dict[str, np.ndarray],
    pasta_saida: Path | None = None,
) -> None:
    pasta_destino = pasta_saida or Path.cwd()
    pasta_destino.mkdir(parents=True, exist_ok=True)

    for ticker, trilhas in simulacoes.items():
        dias = np.arange(trilhas.shape[0])
        p5 = np.percentile(trilhas, 5, axis=1)
        p25 = np.percentile(trilhas, 25, axis=1)
        p50 = np.percentile(trilhas, 50, axis=1)
        p75 = np.percentile(trilhas, 75, axis=1)
        p95 = np.percentile(trilhas, 95, axis=1)

        fig, ax = plt.subplots(figsize=(10, 6))
        ax.fill_between(dias, p5, p95, alpha=0.2, label="Faixa 5%-95%")
        ax.fill_between(dias, p25, p75, alpha=0.35, label="Faixa 25%-75%")
        ax.plot(dias, p50, linewidth=2, label="Mediana (50%)")

        ax.set_title(f"Fan Chart Monte Carlo GBM - {ticker}")
        ax.set_xlabel("Dias")
        ax.set_ylabel("Preço Simulado")
        ax.legend()
        ax.grid(alpha=0.2)

        arquivo_grafico = pasta_destino / f"fan_chart_{ticker.replace('.', '_')}.png"
        fig.tight_layout()
        fig.savefig(arquivo_grafico, dpi=140)
        plt.close(fig)

        print(arquivo_grafico)


def exportar_features_csv(
    retornos_log: pd.DataFrame,
    volatilidade_historica: pd.DataFrame,
    matriz_correlacao: pd.DataFrame,
    resumo_monte_carlo: pd.DataFrame | None = None,
    metricas_risco: pd.DataFrame | None = None,
    metricas_risco_monte_carlo: pd.DataFrame | None = None,
    relatorio_comparativo_risco: pd.DataFrame | None = None,
    precos: pd.DataFrame | None = None,
    pasta_saida: Path | None = None,
) -> None:
    pasta_destino = pasta_saida or Path.cwd()
    pasta_destino.mkdir(parents=True, exist_ok=True)

    arquivo_retornos = pasta_destino / "retornos_logaritmicos.csv"
    arquivo_volatilidade = pasta_destino / "volatilidade_historica_anualizada.csv"
    arquivo_correlacao = pasta_destino / "matriz_correlacao.csv"
    arquivo_monte_carlo = pasta_destino / "monte_carlo_gbm_resumo.csv"
    arquivo_metricas_risco = pasta_destino / "metricas_risco.csv"
    arquivo_precos = pasta_destino / "precos_fechamento.csv"
    arquivo_metricas_risco_monte_carlo = pasta_destino / "metricas_risco_monte_carlo.csv"
    arquivo_relatorio_comparativo = pasta_destino / "metricas_risco_comparativo.csv"

    retornos_log.to_csv(arquivo_retornos, index=True)
    volatilidade_historica.to_csv(arquivo_volatilidade, index=True)
    matriz_correlacao.to_csv(arquivo_correlacao, index=True)
    if resumo_monte_carlo is not None:
        resumo_monte_carlo.to_csv(arquivo_monte_carlo, index=True)
    if metricas_risco is not None:
        metricas_risco.to_csv(arquivo_metricas_risco, index=True)
    if metricas_risco_monte_carlo is not None:
        metricas_risco_monte_carlo.to_csv(arquivo_metricas_risco_monte_carlo, index=True)
    if relatorio_comparativo_risco is not None:
        relatorio_comparativo_risco.to_csv(arquivo_relatorio_comparativo, index=True, float_format="%.4f")
    if precos is not None:
        precos.to_csv(arquivo_precos, index=True)

    print("\nArquivos CSV exportados:")
    print(arquivo_retornos)
    print(arquivo_volatilidade)
    print(arquivo_correlacao)
    if resumo_monte_carlo is not None:
        print(arquivo_monte_carlo)
    if metricas_risco is not None:
        print(arquivo_metricas_risco)
    if metricas_risco_monte_carlo is not None:
        print(arquivo_metricas_risco_monte_carlo)
    if relatorio_comparativo_risco is not None:
        print(arquivo_relatorio_comparativo)
    if precos is not None:
        print(arquivo_precos)


def buscar_noticias(tickers: list[str], pasta_saida: Path, dias: int = 7) -> None:
    """Busca notícias dos últimos `dias` dias para cada ticker via yfinance e exporta noticias.json."""
    agora = datetime.now(tz=timezone.utc).timestamp()
    limite = agora - dias * 86400

    noticias: list[dict] = []
    vistos: set[str] = set()

    for ticker in tickers:
        try:
            raw = yf.Ticker(ticker).news or []
        except Exception:
            raw = []

        for item in raw:
            # yfinance >= 0.2.54 retorna nested 'content'
            content = item.get("content", item)
            title = content.get("title") or item.get("title", "")

            url = ""
            if isinstance(content.get("canonicalUrl"), dict):
                url = content["canonicalUrl"].get("url", "")
            elif isinstance(content.get("clickThroughUrl"), dict):
                url = content["clickThroughUrl"].get("url", "")
            else:
                url = item.get("link", "")

            publisher = ""
            if isinstance(content.get("provider"), dict):
                publisher = content["provider"].get("displayName", "")
            else:
                publisher = item.get("publisher", "")

            pub_time = content.get("pubDate") or item.get("providerPublishTime")
            ts = None
            if isinstance(pub_time, str):
                try:
                    ts = datetime.fromisoformat(pub_time.replace("Z", "+00:00")).timestamp()
                except Exception:
                    ts = None
            elif isinstance(pub_time, (int, float)):
                ts = float(pub_time)

            if ts is None or ts < limite:
                continue

            uid = url or title
            if uid in vistos or not title:
                continue
            vistos.add(uid)

            noticias.append({
                "ticker": ticker,
                "titulo": title,
                "url": url,
                "publicador": publisher,
                "timestamp": int(ts),
                "data": datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%d/%m/%Y %H:%M"),
            })

    noticias.sort(key=lambda x: x["timestamp"], reverse=True)

    pasta_saida.mkdir(parents=True, exist_ok=True)
    arquivo = pasta_saida / "noticias.json"
    arquivo.write_text(json.dumps(noticias, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nNotícias exportadas ({len(noticias)} itens): {arquivo}")


def main() -> None:
    tickers = ["VALE3.SA", "PETR4.SA", "ITUB4.SA"]
    pasta_output = Path.cwd() / "output"

    precos = baixar_precos_fechamento(tickers=tickers, period="5y")
    retornos_log = calcular_retornos_log(precos)
    volatilidade_historica = calcular_volatilidade_historica(retornos_log, janela=21)
    matriz_correlacao = calcular_matriz_correlacao(retornos_log)
    mu_diario, sigma_diario, correlacao = estimar_parametros_gbm(retornos_log)
    simulacoes = simular_monte_carlo_gbm_multivariado(
        precos,
        mu_diario,
        sigma_diario,
        correlacao,
        dias=252,
        n_simulacoes=2000,
        seed=42,
    )
    resumo_monte_carlo = resumir_simulacao_precos_finais(simulacoes)
    metricas_risco = calcular_metricas_risco(retornos_log, precos, nivel_confianca=0.95, taxa_livre_risco_anual=0.0)
    metricas_risco_monte_carlo = calcular_metricas_risco_monte_carlo(
        simulacoes,
        nivel_confianca=0.95,
        taxa_livre_risco_anual=0.0,
    )
    relatorio_comparativo_risco = construir_relatorio_comparativo_risco(
        metricas_risco,
        metricas_risco_monte_carlo,
    )

    print("Preços de fechamento (últimas 5 linhas):")
    print(precos.tail())
    print("\nRetornos logarítmicos (últimas 5 linhas):")
    print(retornos_log.tail())
    print("\nVolatilidade histórica anualizada - janela de 21 dias (últimas 5 linhas):")
    print(volatilidade_historica.tail())
    print("\nMatriz de correlação dos retornos logarítmicos:")
    print(matriz_correlacao)
    print("\nResumo Monte Carlo GBM (preço final em 252 dias):")
    print(resumo_monte_carlo)
    print("\nMétricas de risco:")
    print(metricas_risco)
    print("\nMétricas de risco (Monte Carlo):")
    print(metricas_risco_monte_carlo)
    print("\nRelatório comparativo de risco (Histórico x Monte Carlo):")
    print(relatorio_comparativo_risco)

    exportar_features_csv(
        retornos_log,
        volatilidade_historica,
        matriz_correlacao,
        resumo_monte_carlo,
        metricas_risco,
        metricas_risco_monte_carlo,
        relatorio_comparativo_risco,
        precos,
        pasta_saida=pasta_output,
    )
    print("\nArquivos de fan chart exportados:")
    gerar_fan_chart_monte_carlo(simulacoes, pasta_saida=pasta_output)
    buscar_noticias(tickers, pasta_saida=pasta_output, dias=7)


if __name__ == "__main__":
    main()