import dayjs from "dayjs";
import {
  consultarVinculo,
  consultarMargem
} from "./presencaTermo.js";

function escolherVinculoElegivel(vinculos) {
  return vinculos.find(v => v.elegivel === true) || null;
}

export async function obterMargemETempoEmpresa(token, cpf) {
  // 1) Vínculo
  const vinculo = await consultarVinculo(token, cpf);

  if (!vinculo?.sucesso || !vinculo?.dados?.id?.length) {
    return null;
  }

  const v = escolherVinculoElegivel(vinculo.dados.id);
  if (!v) return null;

  // 2) Margem
  const margem = await consultarMargem(token, {
    cpf,
    matricula: v.matricula,
    cnpj: v.numeroInscricaoEmpregador
  });

  if (!margem?.sucesso || !margem?.dados?.dataAdmissao) {
    return null;
  }

  // 3) Tempo de empresa
  const tempoEmpresaDias = dayjs().diff(
    dayjs(margem.dados.dataAdmissao),
    "day"
  );

  return {
    valor_margem_disponivel: margem.dados.valorMargemDisponivel ?? null,
    tempo_empresa_dias: tempoEmpresaDias,
    data_admissao: margem.dados.dataAdmissao,
    matricula: v.matricula,
    cnpj_empregador: v.numeroInscricaoEmpregador
  };
}
