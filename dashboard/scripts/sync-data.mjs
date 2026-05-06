import { cp, mkdir, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

async function syncCsvData() {
    const projectRoot = resolve(process.cwd(), '..')
    const sourceDir = resolve(projectRoot, 'output')
    const targetDir = resolve(process.cwd(), 'public', 'data')

    await mkdir(targetDir, { recursive: true })

    const files = await readdir(sourceDir)
    const csvFiles = files.filter((file) =>
        file.toLowerCase().endsWith('.csv') || file.toLowerCase().endsWith('.json')
    )

    if (csvFiles.length === 0) {
        console.log('Nenhum CSV encontrado em output.')
        return
    }

    for (const fileName of csvFiles) {
        await cp(resolve(sourceDir, fileName), resolve(targetDir, fileName), { force: true })
    }

    console.log(`Sincronização concluída: ${csvFiles.length} arquivo(s) copiado(s) para public/data.`)
}

syncCsvData().catch((error) => {
    console.error('Falha ao sincronizar CSVs:', error.message)
    process.exit(1)
})
