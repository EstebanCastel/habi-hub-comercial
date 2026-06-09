    async initMetas() {
      this.metasInited = true;
      try {
        const r = await fetch("/api/funnel/inmo?action=metas/config");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        this.metaConfig = await r.json();
        console.log('[initMetas] metaConfig loaded:', { cycles: this.metaConfig.cycles?.length, metasKeys: Object.keys(this.metaConfig.metas || {}) });
        
        this.metaCycles = this.metaConfig.cycles || [];
        this.metaEtapas = this.metaConfig.etapas || [];
        
        // Auto-select the last cycle that HAS metas defined (not just current date)
        // metas_inmo model only defines metas for CICLO_DEFAULT (ciclo 4 = mayo 2026)
        const metasByCiclo = this.metaConfig.metas || {};
        const ciclosConMetas = this.metaCycles.filter(c => 
          Object.keys(metasByCiclo).some(etapa => 
            Object.keys(metasByCiclo[etapa] || {}).some(bucket => 
              Object.keys(metasByCiclo[etapa][bucket] || {}).some(wk => wk.startsWith(`${c.ciclo}-`))
            )
          )
        );
        
        this.metaCiclo = (ciclosConMetas[ciclosConMetas.length - 1] || this.metaCycles[this.metaCycles.length - 1] || {}).ciclo || 0;
        console.log('[initMetas] selected metaCiclo:', this.metaCiclo);
        this.refreshMetas();
      } catch (e) {
        console.error('[initMetas] failed:', e);
      }
    },
